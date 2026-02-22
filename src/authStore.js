const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

const HOME_DIR = path.join(os.homedir(), ".deepseekapi");
const HOME_FILE = path.join(HOME_DIR, "credentials.json");
const PROJECT_FILE = path.resolve(process.cwd(), ".deepseekapi", "credentials.json");
const OVERRIDE_FILE = process.env.DEEPSEEK_AUTH_FILE ? path.resolve(process.env.DEEPSEEK_AUTH_FILE) : "";

function normalizeAuth(data) {
  if (!data || !String(data.cookie || "").trim()) return null;
  return {
    cookie: String(data.cookie).trim(),
    bearer: data.bearer ? String(data.bearer).trim() : undefined,
    userAgent: data.userAgent ? String(data.userAgent).trim() : undefined,
  };
}

async function readOne(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return normalizeAuth(JSON.parse(raw));
  } catch {
    return null;
  }
}

function getReadCandidates() {
  const list = [];
  if (OVERRIDE_FILE) list.push(OVERRIDE_FILE);
  list.push(PROJECT_FILE, HOME_FILE);
  return Array.from(new Set(list));
}

function getPrimaryWriteFile() {
  if (OVERRIDE_FILE) return OVERRIDE_FILE;
  return PROJECT_FILE;
}

async function loadSavedAuth() {
  for (const file of getReadCandidates()) {
    const auth = await readOne(file);
    if (auth) return auth;
  }
  return null;
}

async function writeOne(file, auth) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(auth, null, 2), { mode: 0o600 });
}

async function saveAuth(auth) {
  const normalized = normalizeAuth(auth);
  if (!normalized) throw new Error("Cookie is required");
  await writeOne(getPrimaryWriteFile(), normalized);
  if (getPrimaryWriteFile() !== HOME_FILE) {
    await writeOne(HOME_FILE, normalized);
  }
}

async function promptAuthInteractive() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const cookie = (await rl.question("Paste DeepSeek Cookie: ")).trim();
    if (!cookie) throw new Error("Cookie is required");
    const bearer = (await rl.question("Paste Bearer token (optional): ")).trim();
    const userAgent = (await rl.question("User-Agent (optional): ")).trim();
    return {
      cookie,
      bearer: bearer || undefined,
      userAgent: userAgent || undefined,
    };
  } finally {
    rl.close();
  }
}

module.exports = {
  loadSavedAuth,
  saveAuth,
  promptAuthInteractive,
};
