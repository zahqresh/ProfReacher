const API_URL = 'https://api.openalex.org';
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function normalize(value) {
  return String(value || '').toLocaleLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenSimilarity(left, right) {
  const a = new Set(normalize(left).split(/\s+/).filter(Boolean));
  const b = new Set(normalize(right).split(/\s+/).filter(Boolean));
  if (!a.size || !b.size) return 0;
  const common = [...a].filter((token) => b.has(token)).length;
  return common / new Set([...a, ...b]).size;
}

function institutionName(institution) {
  return institution?.display_name || institution?.name || '';
}

function openAlexShortId(id) {
  return String(id || '').split('/').pop();
}

function institutions(author) {
  return [
    ...(author.last_known_institutions || author.institutions || []),
    ...(author.affiliations || []).map((affiliation) => affiliation.institution).filter(Boolean),
  ];
}

function decodeAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return '';
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const position of positions) words[position] = word;
  }
  return words.filter(Boolean).join(' ');
}

async function getJson(url, apiKey, fetchImpl) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': 'csc-mailer/1.0 (OpenAlex professor research)',
        },
        signal: AbortSignal.timeout(12_000),
      });
    } catch (error) {
      if (attempt === 2) throw new Error(`OpenAlex request failed: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      continue;
    }
    if (!RETRYABLE_STATUSES.has(response.status)) {
      if (!response.ok) throw new Error(`OpenAlex ${response.status} for ${new URL(url).pathname}`);
      return response.json();
    }
    if (attempt === 2) throw new Error(`OpenAlex ${response.status} for ${new URL(url).pathname} after retries`);
    const retryAfter = Number(response.headers.get('retry-after'));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 15_000)
      : 1000 * (attempt + 1);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error('OpenAlex retries exhausted.');
}

function chooseInstitution(results, requestedName) {
  const ranked = [...results]
    .map((result) => ({
      result,
      score: [
        institutionName(result),
        ...(result.display_name_acronyms || []),
        ...(result.display_name_alternatives || []),
      ].reduce((best, candidate) => Math.max(
        best,
        normalize(candidate) === normalize(requestedName) ? 1 : tokenSimilarity(candidate, requestedName),
      ), 0),
    }))
    .sort((a, b) => b.score - a.score);
  if (!ranked[0]) return null;
  if (ranked[1]?.score === ranked[0].score && ranked[0].score < 1) return null;
  return ranked[0];
}

function chooseAuthor(results, name, institutionId, university) {
  const matching = [];
  for (const author of results) {
    const aliases = [author.display_name, ...(author.display_name_alternatives || [])];
    const nameScore = Math.max(...aliases.map((alias) => tokenSimilarity(alias, name)), 0);
    if (nameScore < 0.6) continue;
    const authorInstitutions = institutions(author);
    const institutionScore = institutionId && authorInstitutions.some((item) => item.id === institutionId)
      ? 1
      : Math.max(...authorInstitutions.map((item) => {
        const label = institutionName(item);
        return normalize(label) === normalize(university) ? 1 : tokenSimilarity(label, university);
      }), 0);
    if (institutionScore < 0.6) continue;
    matching.push({ author, nameScore, institutionScore });
  }
  matching.sort((a, b) => b.institutionScore - a.institutionScore
    || b.nameScore - a.nameScore
    || (b.author.works_count || 0) - (a.author.works_count || 0));
  return matching[0] || null;
}

export async function searchOpenAlexProfessor({ name, university }, { apiKey, fetchImpl = fetch } = {}) {
  if (!apiKey?.trim()) throw new Error('OPENALEX_API_KEY is required to use OpenAlex.');
  if (!name?.trim() || !university?.trim()) return '';

  const institutionUrl = new URL(`${API_URL}/institutions`);
  institutionUrl.searchParams.set('search', university);
  institutionUrl.searchParams.set('per_page', '10');
  institutionUrl.searchParams.set('select', 'id,display_name,display_name_acronyms,display_name_alternatives');

  const institutionResponse = await getJson(institutionUrl, apiKey, fetchImpl);
  const institutionMatch = chooseInstitution(institutionResponse.results || [], university);
  if (!institutionMatch || institutionMatch.score < 0.6) {
    return `OpenAlex: no institution could be confidently matched to "${university}". Do not attribute OpenAlex results to this professor.`;
  }

  const institutionId = institutionMatch.result.id.split('/').pop();
  const authorUrl = new URL(`${API_URL}/authors`);
  authorUrl.searchParams.set('search', name);
  authorUrl.searchParams.set('filter', `affiliations.institution.id:${institutionId}`);
  authorUrl.searchParams.set('per_page', '10');
  authorUrl.searchParams.set('select', 'id,display_name,display_name_alternatives,works_count,last_known_institutions,affiliations');
  const authorResponse = await getJson(authorUrl, apiKey, fetchImpl);
  const authorMatch = chooseAuthor(
    authorResponse.results || [],
    name,
    institutionMatch.result.id,
    university,
  );
  if (!authorMatch) {
    return `OpenAlex: no author could be confidently matched to both "${name}" and "${university}". Do not attribute OpenAlex results to this professor.`;
  }

  const fromDate = new Date();
  fromDate.setFullYear(fromDate.getFullYear() - 5);
  const worksUrl = new URL(`${API_URL}/works`);
  worksUrl.searchParams.set('filter', `authorships.author.id:${openAlexShortId(authorMatch.author.id)},from_publication_date:${fromDate.toISOString().slice(0, 10)}`);
  worksUrl.searchParams.set('sort', 'publication_date:desc');
  worksUrl.searchParams.set('per_page', '5');
  worksUrl.searchParams.set('select', 'id,display_name,publication_date,doi,primary_location,abstract_inverted_index');
  const worksResponse = await getJson(worksUrl, apiKey, fetchImpl);
  const works = (worksResponse.results || []).map((work) => {
    const location = work.primary_location?.landing_page_url || work.doi || work.id;
    const abstract = decodeAbstract(work.abstract_inverted_index).slice(0, 1000);
    return [
      `Title: ${work.display_name || 'Untitled work'}`,
      `Date: ${work.publication_date || 'unknown'}`,
      `URL: ${location}`,
      abstract ? `Abstract: ${abstract}` : 'Abstract: not available in OpenAlex',
    ].join('\n');
  });
  const matchedInstitution = institutions(authorMatch.author)
    .map(institutionName)
    .filter(Boolean)
    .join('; ');

  return [
    `OpenAlex author match: ${authorMatch.author.display_name} (institution matched to "${university}"; author institution record: ${matchedInstitution || university}).`,
    `OpenAlex author profile: ${authorMatch.author.id}`,
    `Recent works from the last five years (${works.length} returned):`,
    works.length ? works.map((work, index) => `[OpenAlex ${index + 1}]\n${work}`).join('\n\n') : 'No recent works were returned.',
  ].join('\n');
}
