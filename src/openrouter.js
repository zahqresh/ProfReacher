const MAX_ATTEMPTS = 4;
const FREE_MODEL_MIN_INTERVAL_MS = 3_100;

const isFreeModel = (model) =>
  model === 'openrouter/free' || model.split(':').slice(1).includes('free');

function retryAfterMs(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function responseError(data) {
  const detail = data?.error?.message || data?.error || data?.message || data;
  return typeof detail === 'string' ? detail : JSON.stringify(detail);
}

async function readJson(response) {
  const raw = await response.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { message: raw.slice(0, 300) };
  }
}

export function createOpenRouterClient({
  apiKey,
  baseUrl,
  model,
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  log = () => {},
}) {
  let lastFreeRequestAt = null;
  const usesFreeModel = isFreeModel(model);

  return async function complete(messages) {
    if (!apiKey) throw new Error('OPENROUTER_API_KEY missing');

    const body = { model, messages };
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (usesFreeModel) {
        const allowanceResponse = await fetchImpl(`${baseUrl}/key`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        const allowance = await readJson(allowanceResponse);
        if (!allowanceResponse.ok) {
          throw new Error(`OpenRouter free-model allowance check ${allowanceResponse.status}: ${responseError(allowance).slice(0, 300)}`);
        }
        const remaining = allowance.data?.free_model_daily_requests?.remaining;
        if (!Number.isFinite(remaining)) {
          throw new Error('OpenRouter did not return free-model daily request allowance; check the API key and try again.');
        }
        if (remaining <= 0) {
          throw new Error('OpenRouter free-model daily request allowance is exhausted. Wait for the UTC daily reset or choose another model.');
        }
      }

      if (usesFreeModel && lastFreeRequestAt !== null) {
        const delay = lastFreeRequestAt + FREE_MODEL_MIN_INTERVAL_MS - now();
        if (delay > 0) await sleepImpl(delay);
      }

      lastFreeRequestAt = usesFreeModel ? now() : null;
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (attempt === MAX_ATTEMPTS - 1) {
          throw new Error(`OpenRouter request failed after ${MAX_ATTEMPTS} attempts: ${error.message}`);
        }
        const delay = 5_000 * (2 ** attempt);
        log(`OpenRouter network error; retrying in ${Math.ceil(delay / 1000)}s (attempt ${attempt + 2}/${MAX_ATTEMPTS}).`);
        await sleepImpl(delay);
        continue;
      }

      const data = await readJson(response);

      if (!response.ok) {
        const detail = responseError(data).slice(0, 300);
        if (response.status !== 429 && response.status < 500) {
          throw new Error(`OpenRouter ${response.status}: ${detail}`);
        }
        if (attempt === MAX_ATTEMPTS - 1) {
          const advice = response.status === 429
            ? ' Check the free-model request allowance and retry after it resets.'
            : '';
          throw new Error(`OpenRouter ${response.status} after ${MAX_ATTEMPTS} attempts: ${detail}.${advice}`);
        }

        const backoff = 5_000 * (2 ** attempt);
        const retryAfter = retryAfterMs(response.headers.get('retry-after'), now());
        const delay = retryAfter === null ? backoff : Math.max(backoff, retryAfter);
        log(`OpenRouter ${response.status}; retrying in ${Math.ceil(delay / 1000)}s (attempt ${attempt + 2}/${MAX_ATTEMPTS}).`);
        await sleepImpl(delay);
        continue;
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('OpenRouter returned an empty response');
      return content;
    }

    throw new Error('OpenRouter retries exhausted');
  };
}
