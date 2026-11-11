#!/usr/bin/env node
// Repeatable multi-surface demo recorder (#261):
// Boots an isolated private `plurnk-service` daemon (`PLURNK_WEB_ENABLED=1`) against
// a local OpenAI-compatible inference server (`127.0.0.1:11435`), drives a real shell
// pipeline (`CLI`), an interactive `pi-tui` session (`TUI`), and `@plurnk/plurnk-web`
// (`Web`) in headless Chromium over CDP, and encodes `docs/media/session.webp`.

import { execFileSync, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
    access,
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import xtermHeadless from "@xterm/headless";
import pty from "node-pty";

const Terminal = xtermHeadless.Terminal ?? xtermHeadless.default?.Terminal;
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BIN_PATH = join(REPO_ROOT, "bin", "plurnk.js");

const CANVAS_W = 1440;
const CANVAS_H = 840;
const FULL_COLS = 112;
const SPLIT_COLS = 82;
const TERM_ROWS = 30;

const XTERM_PALETTE_16 = [
    "#0d1117", "#ff7b72", "#3fb950", "#d29922",
    "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4",
    "#6e7681", "#ffa198", "#56d364", "#e3b341",
    "#79c0ff", "#d2a8ff", "#56d4dd", "#f0f6fc",
];

const build256Palette = () => {
    const pal = [...XTERM_PALETTE_16];
    const steps = [0, 95, 135, 175, 215, 255];
    for (let r = 0; r < 6; r += 1) {
        for (let g = 0; g < 6; g += 1) {
            for (let b = 0; b < 6; b += 1) {
                pal.push(
                    `#${steps[r].toString(16).padStart(2, "0")}${steps[g].toString(16).padStart(2, "0")}${steps[b].toString(16).padStart(2, "0")}`,
                );
            }
        }
    }
    for (let i = 0; i < 24; i += 1) {
        const v = (8 + i * 10).toString(16).padStart(2, "0");
        pal.push(`#${v}${v}${v}`);
    }
    return pal;
};
const PALETTE_256 = build256Palette();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const escapeHtml = (value) =>
    value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");

async function locateServiceTarget() {
    const candidates = [
        process.env.PLURNK_SERVICE_CHECKOUT,
        resolve(REPO_ROOT, "..", "plurnk-service"),
    ].filter(Boolean);

    for (const candidate of candidates) {
        const root = resolve(candidate);
        const builtEntry = join(root, "plurnk-core", "dist", "service.js");
        const launchEntry = join(root, "plurnk-core", "dist", "launch", "Launch.js");
        try {
            await access(builtEntry, fsConstants.R_OK);
            await access(launchEntry, fsConstants.R_OK);
            return {
                command: [process.execPath, builtEntry],
                launchUrl: pathToFileURL(await realpath(launchEntry)).href,
                serviceRoot: root,
            };
        } catch {
            // try next candidate
        }
    }

    const req = createRequire(join(REPO_ROOT, "package.json"));
    const pkgPath = req.resolve("@plurnk/plurnk-service/package.json");
    const pkgDir = dirname(pkgPath);
    return {
        command: [process.execPath, join(pkgDir, "dist", "service.js")],
        launchUrl: pathToFileURL(req.resolve("@plurnk/plurnk-service/launch")).href,
        serviceRoot: pkgDir,
    };
}

function findBrowserExecutable() {
    for (const bin of ["chromium", "chromium-browser", "google-chrome"]) {
        try {
            return execFileSync("which", [bin], { encoding: "utf8" }).trim();
        } catch {
            // continue
        }
    }
    throw new Error("No Chromium/Chrome executable found on PATH.");
}

class CdpConnection {
    #ws;
    #nextId = 1;
    #pending = new Map();

    constructor(ws) {
        this.#ws = ws;
        ws.addEventListener("message", (event) => {
            const msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
            if (typeof msg.id === "number") {
                const waiter = this.#pending.get(msg.id);
                if (waiter) {
                    this.#pending.delete(msg.id);
                    if (msg.error) waiter.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                    else waiter.resolve(msg.result);
                }
            }
        });
    }

    static async connect(wsUrl) {
        const ws = new WebSocket(wsUrl);
        await new Promise((resolveOpen, rejectOpen) => {
            ws.addEventListener("open", () => resolveOpen(), { once: true });
            ws.addEventListener("error", (err) => rejectOpen(err), { once: true });
        });
        return new CdpConnection(ws);
    }

    send(method, params = {}, sessionId = undefined, timeoutMs = 15_000) {
        const id = this.#nextId++;
        const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
        return new Promise((resolveSend, rejectSend) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                rejectSend(new Error(`CDP timeout (${timeoutMs}ms) on ${method}`));
            }, timeoutMs);
            this.#pending.set(id, {
                resolve: (val) => {
                    clearTimeout(timer);
                    resolveSend(val);
                },
                reject: (err) => {
                    clearTimeout(timer);
                    rejectSend(err);
                },
            });
            this.#ws.send(JSON.stringify(payload));
        });
    }

    close() {
        try {
            this.#ws.close();
        } catch {
            // ignore
        }
    }
}

async function launchHeadlessBrowser(userDataDir) {
    const exe = findBrowserExecutable();
    const proc = spawn(
        exe,
        [
            "--headless=new",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--hide-scrollbars",
            "--force-dark-mode",
            `--user-data-dir=${userDataDir}`,
            "--remote-debugging-port=0",
            "about:blank",
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
    );

    const wsUrl = await new Promise((resolveWs, rejectWs) => {
        let stderr = "";
        const timer = setTimeout(() => rejectWs(new Error(`Timed out waiting for Chromium CDP:\n${stderr}`)), 15_000);
        proc.stderr.setEncoding("utf8");
        proc.stderr.on("data", (chunk) => {
            stderr += chunk;
            const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/u);
            if (match) {
                clearTimeout(timer);
                resolveWs(match[1]);
            }
        });
        proc.once("exit", (code) => {
            clearTimeout(timer);
            rejectWs(new Error(`Chromium exited prematurely (${String(code)}):\n${stderr}`));
        });
    });

    const cdp = await CdpConnection.connect(wsUrl);
    return {
        cdp,
        async createPage(width, height) {
            const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
            const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
            await cdp.send("Page.enable", {}, sessionId);
            await cdp.send("Runtime.enable", {}, sessionId);
            await cdp.send(
                "Emulation.setDeviceMetricsOverride",
                { width, height, deviceScaleFactor: 1, mobile: false },
                sessionId,
            );
            await cdp.send(
                "Emulation.setEmulatedMedia",
                { features: [{ name: "prefers-color-scheme", value: "dark" }] },
                sessionId,
            );
            return {
                sessionId,
                async setViewport(w, h) {
                    await cdp.send(
                        "Emulation.setDeviceMetricsOverride",
                        { width: w, height: h, deviceScaleFactor: 1, mobile: false },
                        sessionId,
                    );
                },
                async navigate(url) {
                    await cdp.send("Page.bringToFront", {}, sessionId);
                    await cdp.send("Page.navigate", { url }, sessionId);
                    await sleep(150);
                    await this.eval(`new Promise((r) => {
                        if (document.readyState === "complete") r(true);
                        else window.addEventListener("load", () => r(true), { once: true });
                    })`);
                },
                async setHtml(html) {
                    await cdp.send("Page.bringToFront", {}, sessionId);
                    const { frameTree } = await cdp.send("Page.getFrameTree", {}, sessionId);
                    await cdp.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html }, sessionId);
                },
                async eval(expression) {
                    const res = await cdp.send(
                        "Runtime.evaluate",
                        { expression, awaitPromise: true, returnByValue: true },
                        sessionId,
                    );
                    if (res.exceptionDetails) {
                        throw new Error(`Page eval error: ${JSON.stringify(res.exceptionDetails)}`);
                    }
                    return res.result?.value;
                },
                async screenshotPng() {
                    await cdp.send("Page.bringToFront", {}, sessionId);
                    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
                    return Buffer.from(data, "base64");
                },
            };
        },
        async close() {
            cdp.close();
            proc.kill("SIGTERM");
            await new Promise((r) => {
                proc.once("exit", r);
                setTimeout(r, 3_000);
            });
        },
    };
}

export function cellColorCss(mode, color, isFg, dim) {
    let hex = isFg ? "#e6edf3" : null;
    if (mode === 0x01000000 || mode === 0x02000000) {
        hex = PALETTE_256[color & 0xff] ?? hex;
    } else if (mode === 0x03000000) {
        const r = (color >> 16) & 0xff;
        const g = (color >> 8) & 0xff;
        const b = color & 0xff;
        hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    }
    if (!hex) return null;
    if (dim && isFg) {
        const r = Number.parseInt(hex.slice(1, 3), 16);
        const g = Number.parseInt(hex.slice(3, 5), 16);
        const b = Number.parseInt(hex.slice(5, 7), 16);
        return `rgba(${r},${g},${b},0.62)`;
    }
    return hex;
}

export function renderXtermRowsHtml(term, showCursor = true) {
    const buf = term.buffer.active;
    const baseY = buf.viewportY;
    const cursorX = buf.cursorX;
    const cursorY = buf.cursorY;
    const cell = buf.getNullCell();
    const lines = [];

    for (let y = 0; y < term.rows; y += 1) {
        const line = buf.getLine(baseY + y);
        if (!line) {
            lines.push('<div class="tr">&nbsp;</div>');
            continue;
        }
        let rowHtml = "";
        for (let x = 0; x < term.cols; x += 1) {
            line.getCell(x, cell);
            const width = cell.getWidth();
            if (width === 0) continue;
            const chars = cell.getChars() || " ";
            const inverse = Boolean(cell.isInverse());
            const bold = Boolean(cell.isBold());
            const dim = Boolean(cell.isDim());
            const italic = Boolean(cell.isItalic());
            const underline = Boolean(cell.isUnderline());
            const strike = Boolean(cell.isStrikethrough());
            const isCursor = showCursor && y === cursorY && x === cursorX;

            let fg = cellColorCss(cell.getFgColorMode(), cell.getFgColor(), true, dim);
            let bg = cellColorCss(cell.getBgColorMode(), cell.getBgColor(), false, false);
            if (inverse) {
                const origFg = fg ?? "#e6edf3";
                const origBg = bg ?? "#0d1117";
                fg = origBg;
                bg = origFg;
            }
            if (isCursor) {
                fg = "#0d1117";
                bg = "#58a6ff";
            }

            const styles = [];
            if (fg && fg !== "#e6edf3") styles.push(`color:${fg}`);
            if (bg) styles.push(`background:${bg}`);
            if (bold) styles.push("font-weight:700");
            if (italic) styles.push("font-style:italic");
            if (underline || strike) {
                styles.push(`text-decoration:${[underline ? "underline" : "", strike ? "line-through" : ""].filter(Boolean).join(" ")}`);
            }
            if (width === 2) styles.push("display:inline-block;width:2ch");

            const safe = chars === " " ? "&nbsp;" : escapeHtml(chars);
            if (styles.length === 0) {
                rowHtml += safe;
            } else {
                rowHtml += `<span style="${styles.join(";")}">${safe}</span>`;
            }
        }
        lines.push(`<div class="tr">${rowHtml}</div>`);
    }
    return lines.join("");
}

function buildStageShellHtml() {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: ${CANVAS_W}px;
    height: ${CANVAS_H}px;
    overflow: hidden;
    background: radial-gradient(circle at 18% 12%, #182334 0%, #0b0f16 58%, #070a0f 100%);
    font-family: "DejaVu Sans", system-ui, -apple-system, sans-serif;
    color: #e6edf3;
    -webkit-font-smoothing: antialiased;
  }
  .stage {
    width: 100%;
    height: 100%;
    padding: 20px 24px 22px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .topbar {
    height: 34px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 6px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: #c9d1d9;
  }
  .brand-dot {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    background: #2ea043;
    box-shadow: 0 0 10px rgba(46, 160, 67, 0.75);
  }
  .pills {
    display: flex;
    gap: 8px;
  }
  .pill {
    font-size: 12px;
    font-weight: 600;
    padding: 5px 12px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(240, 246, 252, 0.1);
    color: #8b949e;
  }
  .pill.active {
    background: rgba(46, 160, 67, 0.18);
    border-color: rgba(63, 185, 80, 0.55);
    color: #7ee787;
  }
  .panes {
    flex: 1;
    display: flex;
    gap: 18px;
    min-height: 0;
  }
  .window {
    background: #0d1117;
    border: 1px solid rgba(240, 246, 252, 0.14);
    border-radius: 12px;
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
  }
  .win-bar {
    height: 36px;
    background: #161b22;
    border-bottom: 1px solid rgba(240, 246, 252, 0.09);
    display: flex;
    align-items: center;
    padding: 0 14px;
    gap: 10px;
    flex-shrink: 0;
  }
  .dots {
    display: flex;
    gap: 6px;
  }
  .dots span {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
  .dots .r { background: #ff5f56; }
  .dots .y { background: #ffbd2e; }
  .dots .g { background: #27c93f; }
  .win-title {
    flex: 1;
    text-align: center;
    font-size: 12px;
    color: #8b949e;
    font-family: "JetBrainsMono Nerd Font Mono", "DejaVu Sans Mono", monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding-right: 42px;
  }
  .term-body {
    flex: 1;
    padding: 12px 16px;
    font-family: "JetBrainsMono Nerd Font Mono", "DejaVu Sans Mono", "Noto Color Emoji", "Noto Sans Symbols2", monospace;
    font-size: 14px;
    line-height: 22px;
    color: #e6edf3;
    white-space: pre;
    overflow: hidden;
    font-variant-ligatures: none;
  }
  .tr {
    height: 22px;
    line-height: 22px;
    overflow: hidden;
  }
  .web-body {
    flex: 1;
    background: #0d1117;
    overflow: hidden;
    display: flex;
  }
  .web-body img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: top left;
    display: block;
  }
</style>
</head>
<body>
  <div class="stage">
    <div class="topbar">
      <div class="brand">
        <span class="brand-dot"></span>
        <span id="caption">Plurnk — One daemon, shared live session across CLI, TUI, and Web</span>
      </div>
      <div class="pills">
        <span class="pill" id="pill-cli">1 · CLI Pipeline</span>
        <span class="pill" id="pill-tui">2 · Interactive TUI</span>
        <span class="pill" id="pill-web">3 · Live Web Sync</span>
      </div>
    </div>
    <div class="panes">
      <div class="window" id="term-win" style="flex: 1 1 100%">
        <div class="win-bar">
          <div class="dots"><span class="r"></span><span class="y"></span><span class="g"></span></div>
          <div class="win-title" id="term-title">Terminal — ~/retry-budget</div>
        </div>
        <div class="term-body" id="term-grid"></div>
      </div>
      <div class="window" id="web-win" style="display: none; flex: 0 0 654px">
        <div class="win-bar">
          <div class="dots"><span class="r"></span><span class="y"></span><span class="g"></span></div>
          <div class="win-title" id="web-title">Plurnk Web — 127.0.0.1:1066</div>
        </div>
        <div class="web-body"><img id="web-img" alt=""></div>
      </div>
    </div>
  </div>
  <script>
    window.updateStage = async (state) => {
      document.getElementById("caption").textContent = state.caption;
      document.getElementById("pill-cli").className = "pill" + (state.act === "cli" ? " active" : "");
      document.getElementById("pill-tui").className = "pill" + (state.act === "tui" ? " active" : "");
      document.getElementById("pill-web").className = "pill" + (state.act === "web" ? " active" : "");
      document.getElementById("term-title").textContent = state.termTitle;
      const grid = document.getElementById("term-grid");
      grid.style.fontSize = state.split ? "13px" : "14px";
      grid.style.padding = state.split ? "12px 14px" : "12px 16px";
      grid.innerHTML = state.termHtml;
      const webWin = document.getElementById("web-win");
      const termWin = document.getElementById("term-win");
      if (state.split) {
        webWin.style.display = "flex";
        webWin.style.flex = "0 0 " + state.webWidth + "px";
        termWin.style.flex = "1 1 auto";
        document.getElementById("web-title").textContent = state.webTitle;
        const img = document.getElementById("web-img");
        if (state.webDataUrl && img.getAttribute("src") !== state.webDataUrl) {
          img.setAttribute("src", state.webDataUrl);
          try { await img.decode(); } catch {}
        }
      } else {
        webWin.style.display = "none";
        termWin.style.flex = "1 1 100%";
      }
    };
  </script>
</body>
</html>`;
}

export async function seedDemoProject(projectDir) {
    await mkdir(join(projectDir, "src"), { recursive: true });
    await mkdir(join(projectDir, "test"), { recursive: true });
    const cleanSource = [
        "export function computeRetryDelayMs(attempt, baseMs = 200) {",
        "    const exp = baseMs * 2 ** Math.max(0, attempt - 1);",
        "    const jitter = 0.5 + Math.random() * 0.5;",
        "    return Math.round(exp * jitter);",
        "}",
        "",
    ].join("\n");
    const testSource = [
        'import assert from "node:assert/strict";',
        'import test from "node:test";',
        'import { computeRetryDelayMs } from "../src/retry.js";',
        "",
        'test("computeRetryDelayMs stays within [0.5x, 1.0x] backoff window", () => {',
        "    for (let i = 0; i < 32; i += 1) {",
        "        const delay = computeRetryDelayMs(2, 200);",
        "        assert.ok(delay >= 200 && delay <= 400, `unexpected delay: ${delay}`);",
        "    }",
        "});",
        "",
    ].join("\n");
    await writeFile(join(projectDir, "src", "retry.js"), cleanSource, "utf8");
    await writeFile(join(projectDir, "test", "retry.test.js"), testSource, "utf8");

    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: projectDir });
    execFileSync("git", ["config", "user.name", "demo"], { cwd: projectDir });
    execFileSync("git", ["config", "user.email", "demo@example.invalid"], { cwd: projectDir });
    execFileSync("git", ["add", "."], { cwd: projectDir });
    execFileSync("git", ["commit", "-q", "-m", "feat: initial retry backoff"], { cwd: projectDir });

    const buggySource = [
        "export function computeRetryDelayMs(attempt, baseMs = 200) {",
        "    const exp = baseMs * 2 ** Math.max(0, attempt - 1);",
        "    const jitter = 0;",
        "    return Math.round(exp * jitter);",
        "}",
        "",
    ].join("\n");
    await writeFile(join(projectDir, "src", "retry.js"), buggySource, "utf8");
}

function encodeAnimatedWebp(framesDir, manifestPath, outPath) {
    const py = `
import json, os
from PIL import Image

with open(${JSON.stringify(manifestPath)}, "r", encoding="utf-8") as fh:
    manifest = json.load(fh)

images = []
durations = []
for item in manifest["frames"]:
    im = Image.open(os.path.join(${JSON.stringify(framesDir)}, item["file"])).convert("RGB")
    images.append(im)
    durations.append(int(item["durationMs"]))

os.makedirs(os.path.dirname(${JSON.stringify(outPath)}), exist_ok=True)
images[0].save(
    ${JSON.stringify(outPath)},
    format="WEBP",
    save_all=True,
    append_images=images[1:],
    duration=durations,
    loop=0,
    quality=88,
    method=6,
)
print(f"Encoded {len(images)} frames -> {os.path.getsize(${JSON.stringify(outPath)})} bytes")
`;
    const out = execFileSync("python3", ["-c", py], { encoding: "utf8" });
    process.stdout.write(out);
}

const HELP_TEXT = `Usage: node scripts/record-demo.mjs [options]

Options:
  --out <path>              Output animated WebP path (default: docs/media/session.webp)
  --work-dir <dir>          Retain intermediate PNG frames, manifest.json, and pty.raw
  --model <alias>           Model alias to configure on the sandbox daemon (default: rtx5070)
  --effort <level>          Reasoning effort (default: medium)
  --openai-base-url <url>   OpenAI-compatible server URL (default: http://127.0.0.1:11435)
  --help, -h                Show this help text
`;

export async function main(argv = process.argv.slice(2)) {
    const { values } = parseArgs({
        args: argv,
        options: {
            help: { type: "boolean", short: "h", default: false },
            out: { type: "string", default: join(REPO_ROOT, "docs", "media", "session.webp") },
            "work-dir": { type: "string" },
            model: { type: "string", default: process.env.PLURNK_DEMO_MODEL ?? "rtx5070" },
            effort: { type: "string", default: process.env.PLURNK_DEMO_EFFORT ?? "medium" },
            "openai-base-url": {
                type: "string",
                default: process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:11435",
            },
        },
    });
    if (values.help) {
        process.stdout.write(HELP_TEXT);
        return;
    }
    const outPath = resolve(values.out);
    const keepWorkDir = Boolean(values["work-dir"]);
    const sandbox = values["work-dir"]
        ? resolve(values["work-dir"])
        : await mkdtemp(join(tmpdir(), "plurnk-record-demo-"));
    const homeDir = join(sandbox, "home");
    const stateDir = join(sandbox, "state");
    const chromeDir = join(sandbox, "chrome");
    const framesDir = join(sandbox, "frames");
    const projectDir = join(homeDir, "retry-budget");
    const handoffFile = join(sandbox, "handoff-url.txt");
    const browserCaptureScript = join(sandbox, "capture-browser.sh");

    await mkdir(framesDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await mkdir(chromeDir, { recursive: true });
    await mkdir(join(homeDir, ".config", "plurnk"), { recursive: true });
    await seedDemoProject(projectDir);

    await writeFile(
        browserCaptureScript,
        `#!/usr/bin/env sh\nprintf '%s' "$1" > ${JSON.stringify(handoffFile)}\nexit 0\n`,
        "utf8",
    );
    await chmod(browserCaptureScript, 0o755);

    const modelAlias = values.model;
    const configEnv = [
        `OPENAI_BASE_URL=${values["openai-base-url"]}`,
        "OPENAI_API_KEY=local",
        `PLURNK_MODEL_${modelAlias}=openai/${modelAlias}`,
        `PLURNK_PROVIDERS_REASONING_EFFORTS_${modelAlias}=low,medium,high,xhigh,max`,
        `PLURNK_PROVIDERS_MAX_CONCURRENCY_${modelAlias}=1`,
        `PLURNK_PROVIDERS_EFFORT_${modelAlias}=${values.effort}`,
        `PLURNK_MODEL=${modelAlias}`,
        "",
    ].join("\n");
    await writeFile(join(homeDir, ".config", "plurnk", ".env"), configEnv, "utf8");

    const target = await locateServiceTarget();
    const launchMod = await import(target.launchUrl);
    const Launch = launchMod.default;

    let daemon = null;
    let browser = null;
    let shellPty = null;

    try {
        process.stdout.write("Starting isolated plurnk-service daemon with PLURNK_WEB_ENABLED=1...\n");
        daemon = await Launch.start({
            command: target.command,
            cwd: target.serviceRoot,
            stateRoot: stateDir,
            lifetime: "ephemeral",
            port: 0,
            env: {
                ...process.env,
                HOME: homeDir,
                XDG_CONFIG_HOME: join(homeDir, ".config"),
                XDG_DATA_HOME: join(homeDir, ".local", "share"),
                XDG_STATE_HOME: join(homeDir, ".local", "state"),
                PLURNK_WEB_ENABLED: "1",
                PLURNK_AUTH: "1",
                OPENAI_BASE_URL: values["openai-base-url"],
                OPENAI_API_KEY: "local",
                [`PLURNK_MODEL_${modelAlias}`]: `openai/${modelAlias}`,
                [`PLURNK_PROVIDERS_REASONING_EFFORTS_${modelAlias}`]: "low,medium,high,xhigh,max",
                [`PLURNK_PROVIDERS_MAX_CONCURRENCY_${modelAlias}`]: "1",
                [`PLURNK_PROVIDERS_EFFORT_${modelAlias}`]: values.effort,
                PLURNK_MODEL: modelAlias,
            },
            readyTimeoutMs: 30_000,
            stopGraceMs: 5_000,
        });
        const daemonUrl = new URL(daemon.url);
        process.stdout.write(`Daemon listening at ${daemon.url}\n`);

        browser = await launchHeadlessBrowser(chromeDir);
        const stagePage = await browser.createPage(CANVAS_W, CANVAS_H);
        await stagePage.setHtml(buildStageShellHtml());
        let webPage = null;

        const xterm = new Terminal({ cols: FULL_COLS, rows: TERM_ROWS, allowProposedApi: true, scrollback: 200 });
        let xtermQueue = Promise.resolve();
        const feedXterm = (chunk) => {
            xtermQueue = xtermQueue.then(() => new Promise((r) => xterm.write(chunk, r)));
            return xtermQueue;
        };

        let rawPtyLog = "";
        shellPty = pty.spawn("/bin/bash", ["--norc", "--noprofile", "-i"], {
            name: "xterm-256color",
            cols: FULL_COLS,
            rows: TERM_ROWS,
            cwd: projectDir,
            env: {
                PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
                HOME: homeDir,
                USER: "dev",
                LOGNAME: "dev",
                TERM: "xterm-256color",
                COLORTERM: "truecolor",
                LANG: "C.UTF-8",
                PS1: "\\[\\033[1;32m\\]~/retry-budget\\[\\033[0m\\] \\[\\033[1;34m\\]$\\[\\033[0m\\] ",
                PROMPT_COMMAND: "",
                DISPLAY: "",
                WAYLAND_DISPLAY: "",
                BROWSER: browserCaptureScript,
                XDG_CONFIG_HOME: join(homeDir, ".config"),
                XDG_DATA_HOME: join(stateDir, "data"),
                XDG_STATE_HOME: join(stateDir, "state"),
                PLURNK_HOST: daemonUrl.hostname,
                PLURNK_PORT: daemonUrl.port,
                PLURNK_ACP_URL: "",
                PLURNK_CLIENT_AUTOSTART: "0",
                PLURNK_CLIENT_COLOR: "always",
            },
        });

        let da1Answered = false;
        let ptyCursorVisible = true;
        shellPty.onData((chunk) => {
            rawPtyLog += chunk;
            if (!da1Answered && chunk.includes("\x1b[c")) {
                da1Answered = true;
                shellPty.write("\x1b]10;rgb:e6e6/edef/f3f3\x07\x1b]11;rgb:0d0d/1111/1717\x07\x1b[?62;22c");
            }
            if (chunk.includes("\x1b[6n")) {
                shellPty.write("\x1b[1;1R");
            }
            const hideIdx = chunk.lastIndexOf("\x1b[?25l");
            const showIdx = chunk.lastIndexOf("\x1b[?25h");
            if (hideIdx !== -1 || showIdx !== -1) {
                ptyCursorVisible = showIdx > hideIdx;
            }
            void feedXterm(chunk);
        });

        const getScreenText = async () => {
            await xtermQueue;
            const buf = xterm.buffer.active;
            const lines = [];
            for (let y = 0; y < xterm.rows; y += 1) {
                lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? "");
            }
            return lines.join("\n");
        };

        const frames = [];
        let stageState = {
            act: "cli",
            caption: "1/3 · Unix CLI — pipe git diff into a named daemon session",
            termTitle: "Terminal — ~/retry-budget",
            split: false,
            webWidth: 654,
            webTitle: `Plurnk Web — ${daemonUrl.host}`,
            webDataUrl: "",
            showCursor: true,
        };

        const scrollWebMainToBottom = async () => {
            if (!webPage) return;
            await webPage.eval(`(() => {
                const main = document.querySelector("body > main");
                if (main) main.scrollTop = main.scrollHeight;
            })()`);
        };

        const captureFrame = async (durationMs, refreshWeb = false, followWebTail = false) => {
            await xtermQueue;
            if (stageState.split && refreshWeb && webPage) {
                if (followWebTail) await scrollWebMainToBottom();
                const webPng = await webPage.screenshotPng();
                stageState.webDataUrl = `data:image/png;base64,${webPng.toString("base64")}`;
            }
            const termHtml = renderXtermRowsHtml(xterm, stageState.showCursor && ptyCursorVisible);
            await stagePage.eval(`window.updateStage(${JSON.stringify({ ...stageState, termHtml })})`);
            const png = await stagePage.screenshotPng();
            const file = `frame-${String(frames.length).padStart(4, "0")}.png`;
            await writeFile(join(framesDir, file), png);
            frames.push({ file, durationMs, act: stageState.act });
        };

        const typeText = async (text, chunkSize = 5, stepMs = 45) => {
            for (let i = 0; i < text.length; i += chunkSize) {
                shellPty.write(text.slice(i, i + chunkSize));
                await sleep(stepMs);
                await captureFrame(80, false);
            }
        };

        const waitForScreen = async (
            predicate,
            { timeoutMs = 120_000, sampleMs = 260, refreshWeb = false, followWebTail = false } = {},
        ) => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const screen = await getScreenText();
                if (predicate(screen)) return screen;
                await captureFrame(sampleMs, refreshWeb, followWebTail);
                await sleep(sampleMs);
            }
            const finalScreen = await getScreenText();
            throw new Error(`Timed out waiting on screen state.\nCurrent screen:\n${finalScreen}\nDaemon stderr:\n${daemon.stderr()}`);
        };

        // Settle clean bash prompt
        shellPty.write(`alias plurnk='node ${BIN_PATH}'\rclear\r`);
        await sleep(500);
        await xtermQueue;

        const webOrigin = daemonUrl.origin;

        // ── ACT I: CLI Unix Pipeline ──
        process.stdout.write("Act I: Recording CLI pipeline...\n");
        await captureFrame(500);
        const cliCmd = `git diff | plurnk --session audit "Spot the retry bug in one short sentence."`;
        await typeText(cliCmd, 6, 38);
        await captureFrame(350);
        shellPty.write("\r");

        await waitForScreen(
            (s) => {
                const lines = s.trim().split("\n");
                return lines.length >= 3 && lines.at(-1)?.includes("~/retry-budget $") && !lines.at(-1)?.includes("git diff");
            },
            { timeoutMs: 90_000, sampleMs: 260 },
        );
        await captureFrame(1400);

        // ── ACT II: Interactive TUI (--yolo) Waterfall + 💭 Ticker + /web ──
        process.stdout.write("Act II: Recording interactive TUI (--yolo) session...\n");
        stageState.act = "tui";
        stageState.caption = "2/3 · Interactive TUI — resume session, live 💭 reasoning ticker & operation waterfall";
        da1Answered = false;
        await typeText("plurnk --yolo --session audit", 5, 42);
        await captureFrame(300);
        shellPty.write("\r");

        await waitForScreen((s) => s.includes("~audit") && s.includes("⏹️"), {
            timeoutMs: 30_000,
            sampleMs: 220,
        });
        await captureFrame(800);

        const tuiPrompt =
            "Fix src/retry.js so jitter is 0.5 + Math.random() * 0.5, run node --test, and confirm in one short sentence.";
        await typeText(tuiPrompt, 8, 38);
        await captureFrame(350);
        shellPty.write("\r");

        // Wait for loop 2 to enter active execution (`(2/` without `⏹️`), then capture live 💭 ticker + waterfall until idle (`(2/` with `⏹️`)
        await waitForScreen((s) => (s.includes("(2/") && !s.includes("⏹️")) || s.includes("💭"), {
            timeoutMs: 30_000,
            sampleMs: 200,
        });
        await waitForScreen(
            (s) => s.includes("(2/") && s.includes("⏹️"),
            { timeoutMs: 120_000, sampleMs: 250 },
        );
        await captureFrame(1300);

        // Hand off live session to Plurnk Web (`/web`)
        await typeText("/web", 2, 70);
        await captureFrame(300);
        shellPty.write("\r");

        await waitForScreen((s) => s.includes("Opened Plurnk Web in your browser."), {
            timeoutMs: 15_000,
            sampleMs: 220,
        });
        await captureFrame(800);

        const handoffUrl = (await readFile(handoffFile, "utf8")).trim();
        if (!handoffUrl.startsWith("http://")) {
            throw new Error(`Expected HTTP handoff URL, got: ${handoffUrl}`);
        }

        // ── ACT III: 50/50 Split Terminal + Plurnk Web Live Sync ──
        process.stdout.write("Act III: Opening Plurnk Web via OAuth handoff and streaming live across both clients...\n");
        webPage = await browser.createPage(654, 718);
        await webPage.navigate(handoffUrl);
        await sleep(500);

        stageState.act = "web";
        stageState.caption = "3/3 · Plurnk Web — /web opens the live workspace & session alongside the TUI";
        stageState.split = true;
        shellPty.resize(SPLIT_COLS, TERM_ROWS);
        xterm.resize(SPLIT_COLS, TERM_ROWS);
        await sleep(350);

        // Show workspace overview card (`🗂️ ~/retry-budget` + `💬 audit`), then enter the live `audit` session
        const wsPath = "/~/~/retry-budget/";
        const sessionPath = "/~/~/retry-budget@audit/";
        await webPage.navigate(`${webOrigin}${wsPath}`);
        await sleep(550);
        stageState.webTitle = `Plurnk Web — ${wsPath}`;
        await captureFrame(1100, true, false);

        await webPage.navigate(`${webOrigin}${sessionPath}`);
        stageState.webTitle = `Plurnk Web — ${sessionPath}`;

        // Wait until Plurnk Web connects to ACP session (`data-connection="connected"`)
        const webConnectDeadline = Date.now() + 30_000;
        while (Date.now() < webConnectDeadline) {
            const connected = await webPage.eval(
                `Boolean(document.querySelector('[data-connection="connected"]') && document.querySelector('#session-message'))`,
            );
            await captureFrame(260, true, true);
            if (connected) break;
            await sleep(240);
        }
        await scrollWebMainToBottom();
        await sleep(250);
        await captureFrame(900, true, true);

        // Enable YOLO in Web if not pressed and submit a follow-up Mermaid prompt from the browser composer!
        stageState.caption = "3/3 · Live Multi-Client Sync — prompt in Web streams into both Web and TUI simultaneously";
        const webPrompt =
            "Summarize the fix in 2 short bullets and a 3-node ```mermaid flowchart LR``` using short 1-word node labels (Zero --> Jitter --> Pass).";
        await webPage.eval(`(() => {
            const yolo = document.querySelector("#session-yolo");
            if (yolo && yolo.getAttribute("aria-pressed") === "false") yolo.click();
            const field = document.querySelector("#session-message");
            if (field) {
                field.focus();
                field.value = ${JSON.stringify(webPrompt)};
                field.dispatchEvent(new Event("input", { bubbles: true }));
            }
            const main = document.querySelector("body > main");
            if (main) main.scrollTop = main.scrollHeight;
        })()`);
        await sleep(250);
        await captureFrame(1000, true, true);

        await webPage.eval(`(() => {
            const form = document.querySelector("#session-compose");
            if (form) form.requestSubmit();
        })()`);

        // Wait for loop 3 to start in TUI, then capture both TUI and Web streaming live until settled (`(3/` with `⏹️`)!
        await waitForScreen((s) => (s.includes("(3/") && !s.includes("⏹️")) || s.includes("💭"), {
            timeoutMs: 30_000,
            sampleMs: 220,
            refreshWeb: true,
            followWebTail: true,
        });
        await waitForScreen(
            (s) => s.includes("(3/") && s.includes("⏹️"),
            { timeoutMs: 120_000, sampleMs: 260, refreshWeb: true, followWebTail: true },
        );

        // Wait for Web Mermaid SVG to finish rendering and scroll `body > main` so final reply + SVG diagram sit in view
        const mermaidDeadline = Date.now() + 15_000;
        while (Date.now() < mermaidDeadline) {
            const ready = await webPage.eval(`Boolean(document.querySelector('[data-mermaid] svg'))`);
            if (ready) break;
            await sleep(250);
        }
        await scrollWebMainToBottom();
        await sleep(300);

        stageState.caption = "Plurnk — Perpetual context & shared live state across CLI, TUI, and Web";
        await captureFrame(5200, true, true);
        const manifestPath = join(sandbox, "manifest.json");
        const totalDurationMs = frames.reduce((acc, f) => acc + f.durationMs, 0);
        const manifest = {
            recordedAt: new Date().toISOString(),
            canvas: { width: CANVAS_W, height: CANVAS_H },
            model: modelAlias,
            effort: values.effort,
            frameCount: frames.length,
            totalDurationMs,
            frames,
        };
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
        await writeFile(join(sandbox, "pty.raw"), rawPtyLog, "utf8");

        process.stdout.write(
            `Captured ${frames.length} frames (${(totalDurationMs / 1000).toFixed(1)}s playback). Encoding WebP...\n`,
        );
        encodeAnimatedWebp(framesDir, manifestPath, outPath);
    } finally {
        try {
            shellPty?.kill();
        } catch {
            // ignore
        }
        await browser?.close();
        await daemon?.stop();
        if (!keepWorkDir) {
            await rm(sandbox, { recursive: true, force: true });
        } else {
            process.stdout.write(`Retained capture artifacts in ${sandbox}\n`);
        }
    }
}

if (import.meta.main) {
    await main();
}