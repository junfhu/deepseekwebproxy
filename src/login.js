require("dotenv").config();

const { chromium } = require("playwright");
const { saveAuth } = require("./authStore.js");

const deepseekUrl = process.env.DEEPSEEK_URL || "https://chat.deepseek.com/";
const browserProfileDir = process.env.BROWSER_PROFILE_DIR || ".deepseek-profile";
const loginTimeoutMs = Number(process.env.LOGIN_TIMEOUT_MS || 600000);

function parseBearer(authorizationHeader) {
  if (!authorizationHeader) return "";
  const value = String(authorizationHeader).trim();
  if (!/^bearer\s+/i.test(value)) return "";
  return value.replace(/^bearer\s+/i, "").trim();
}

async function buildCookieStringFromContext(context) {
  const cookies = await context.cookies(["https://chat.deepseek.com", "https://deepseek.com"]);
  if (!cookies.length) return "";
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function main() {
  const context = await chromium.launchPersistentContext(browserProfileDir, {
    headless: false,
    viewport: { width: 1366, height: 900 },
  });

  const page = context.pages()[0] || (await context.newPage());

  const state = {
    cookie: "",
    bearer: "",
    userAgent: "",
    seenApiRequest: false,
    finished: false,
  };

  const finish = async (source) => {
    if (state.finished) return;

    if (!state.cookie) state.cookie = await buildCookieStringFromContext(context);
    if (!state.userAgent) {
      try {
        state.userAgent = await page.evaluate(() => navigator.userAgent || "");
      } catch {
        state.userAgent = "";
      }
    }

    if (!state.cookie) return;

    await saveAuth({
      cookie: state.cookie,
      bearer: state.bearer || undefined,
      userAgent: state.userAgent || undefined,
    });

    state.finished = true;
    console.log(`[login] credentials captured via ${source}`);
    console.log(`[login] cookie: ${state.cookie ? "ok" : "missing"}, bearer: ${state.bearer ? "ok" : "missing"}`);
    await context.close();
  };

  context.on("request", async (request) => {
    if (state.finished) return;

    const url = request.url();
    if (!url.includes("chat.deepseek.com/api/v0/")) return;

    const headers = request.headers();
    const cookie = String(headers.cookie || "").trim();
    const bearer = parseBearer(headers.authorization || headers.Authorization);
    const userAgent = String(headers["user-agent"] || headers["User-Agent"] || "").trim();

    if (url.includes("/api/v0/chat/")) state.seenApiRequest = true;
    if (cookie) state.cookie = cookie;
    if (bearer) state.bearer = bearer;
    if (userAgent) state.userAgent = userAgent;

    if (state.cookie && state.seenApiRequest) await finish("network request");
  });

  await page.goto(deepseekUrl, { waitUntil: "domcontentloaded" });

  console.log(`[login] opened: ${deepseekUrl}`);
  console.log(`[login] profile dir: ${browserProfileDir}`);
  console.log("[login] 请在打开的页面完成登录，然后发送一条任意消息。程序会自动抓取并保存 Cookie/Bearer。");

  const pollTimer = setInterval(async () => {
    if (state.finished) return;
    try {
      const cookie = await buildCookieStringFromContext(context);
      if (cookie) state.cookie = cookie;
      if (state.cookie && state.seenApiRequest) await finish("cookie poll + api seen");
    } catch {}
  }, 1500);

  try {
    const start = Date.now();
    while (!state.finished && Date.now() - start < loginTimeoutMs) {
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!state.finished) {
      if (!state.cookie) state.cookie = await buildCookieStringFromContext(context);
      if (state.cookie) {
        await finish("timeout fallback");
      } else {
        throw new Error("Timeout: 未捕获到有效 Cookie。请确认已登录并发送过消息。");
      }
    }
  } finally {
    clearInterval(pollTimer);
    if (!state.finished) await context.close();
  }

  console.log("[login] credentials saved");
}

main().catch((err) => {
  console.error("[login] failed:", err?.message || err);
  process.exit(1);
});
