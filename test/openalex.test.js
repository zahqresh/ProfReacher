import test from 'node:test';
import assert from 'node:assert/strict';
import { searchOpenAlexProfessor } from '../src/openalex.js';

const institution = {
  id: 'https://openalex.org/I123',
  display_name: 'Example University',
};
const apiKey = 'unit-test-openalex';

test('searches by author and institution, then includes recent work abstracts', async () => {
  const requested = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    requested.push(parsed);
    assert.equal(options.headers.Authorization, `Bearer ${apiKey}`);
    assert.equal(parsed.searchParams.has('api_key'), false);
    if (parsed.pathname === '/institutions') {
      return Response.json({ results: [institution] });
    }
    if (parsed.pathname === '/authors') {
      assert.equal(parsed.searchParams.get('search'), 'Ada Lovelace');
      assert.equal(parsed.searchParams.get('filter'), 'affiliations.institution.id:I123');
      return Response.json({
        results: [{
          id: 'https://openalex.org/A456',
          display_name: 'Ada Lovelace',
          works_count: 12,
          last_known_institutions: [institution],
          affiliations: [{ institution, years: [2025] }],
        }],
      });
    }
    assert.equal(parsed.pathname, '/works');
    assert.match(parsed.searchParams.get('filter'), /authorships\.author\.id:A456/);
    assert.equal(parsed.searchParams.get('per_page'), '5');
    return Response.json({
      results: [{
        id: 'https://openalex.org/W789',
        display_name: 'A recent research paper',
        publication_date: '2025-02-03',
        doi: 'https://doi.org/10.1234/example',
        primary_location: { landing_page_url: 'https://example.edu/paper' },
        abstract_inverted_index: {
          'Drug': [0],
          'target': [1],
          'binding': [2],
          'prediction.': [3],
        },
      }],
    });
  };

  const context = await searchOpenAlexProfessor(
    { name: 'Ada Lovelace', university: 'Example University' },
    { apiKey, fetchImpl },
  );

  assert.equal(requested.length, 3);
  assert.match(context, /institution matched to "Example University"/);
  assert.match(context, /A recent research paper/);
  assert.match(context, /Abstract: Drug target binding prediction\./);
  assert.match(context, /https:\/\/example\.edu\/paper/);
});

test('does not attribute a same-name author affiliated with another university', async () => {
  let workRequests = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/institutions') return Response.json({ results: [institution] });
    if (parsed.pathname === '/authors') {
      return Response.json({
        results: [{
          id: 'https://openalex.org/A000',
          display_name: 'Ada Lovelace',
          affiliations: [{
            institution: { id: 'https://openalex.org/I999', display_name: 'Different University' },
            years: [2025],
          }],
        }],
      });
    }
    workRequests += 1;
    throw new Error('Must not request works for an unverified author.');
  };

  const context = await searchOpenAlexProfessor(
    { name: 'Ada Lovelace', university: 'Example University' },
    { apiKey, fetchImpl },
  );
  assert.match(context, /no author could be confidently matched/);
  assert.equal(workRequests, 0);
});

test('stops before author search if the institution cannot be matched', async () => {
  let requests = 0;
  const context = await searchOpenAlexProfessor(
    { name: 'Ada Lovelace', university: 'Unknown University' },
    {
      apiKey,
      fetchImpl: async () => {
        requests += 1;
        return Response.json({ results: [] });
      },
    },
  );
  assert.match(context, /no institution could be confidently matched/);
  assert.equal(requests, 1);
});

test('requires an API key before making any OpenAlex requests', async () => {
  let requests = 0;
  await assert.rejects(
    searchOpenAlexProfessor(
      { name: 'Ada Lovelace', university: 'Example University' },
      { fetchImpl: async () => { requests += 1; } },
    ),
    /OPENALEX_API_KEY is required/,
  );
  assert.equal(requests, 0);
});
