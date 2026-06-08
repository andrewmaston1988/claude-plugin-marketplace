const SLACK_API = "https://slack.com/api";
const API_TIMEOUT_MS = 10_000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function createWebClient({ token, log }) {
  async function call(method, body) {
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("Retry-After") ?? "1", 10);
      log.warn("rate limited", { method, retryAfter });
      await sleep(retryAfter * 1000);
      // One retry
      const res2 = await fetch(`${SLACK_API}/${method}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (res2.status === 429) {
        log.warn("rate limited again, giving up", { method });
        const err = new Error(`Slack ${method}: rate limited`);
        err.slackError = "ratelimited";
        err.method = method;
        throw err;
      }
      return parseResponse(method, res2);
    }

    return parseResponse(method, res);
  }

  async function parseResponse(method, res) {
    const json = await res.json();
    if (!json.ok) {
      const err = new Error(`Slack ${method}: ${json.error}`);
      err.slackError = json.error;
      err.method = method;
      throw err;
    }
    return json;
  }

  return {
    authTest: () => call("auth.test", {}),

    chatPostMessage: (params) => call("chat.postMessage", params),

    chatUpdate: (params) => {
      // Never pass "id" field — Slack caches attachment content by id, causing stale placeholder updates.
      const { id: _id, ...rest } = params;
      return call("chat.update", rest);
    },

    chatDelete: (params) => call("chat.delete", params),

    conversationsHistory: (params) => call("conversations.history", params),

    conversationsReplies: (params) => call("conversations.replies", params),

    appsConnectionsOpen: () =>
      fetch(`${SLACK_API}/apps.connections.open`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        signal: AbortSignal.timeout(15_000),
      }).then(r => r.json()).then(json => {
        if (!json.ok) {
          const err = new Error(`Slack apps.connections.open: ${json.error}`);
          err.slackError = json.error;
          throw err;
        }
        return json;
      }),
  };
}
