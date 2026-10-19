// Full browser run: two rooms playing at the same time, each with a 1920x1080 host and four
// 390x844 phones. Covers a phone reload mid-turn, a host reload mid-round, a turn running out,
// a host dropping out, a full room, a bad code and a server restart. Fails on console errors.
//
//   npm run test:browser            (needs Playwright: npm i -g playwright)
//   SCREENSHOTS=/some/dir npm run test:browser
//
// Uses a globally installed Playwright so it isn't a dependency of the app.
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert/strict');

const { chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));

const PORT = Number(process.env.E2E_PORT) || 3456;
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.SCREENSHOTS || path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);

// ---------- server (tracked by PID, never pkill) ----------
let serverProc = null;
async function startServer() {
    serverProc = spawn(process.execPath, ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: String(PORT), MAX_PLAYERS_PER_ROOM: '4' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    for (let i = 0; i < 50; i++) {
        try {
            if ((await fetch(`${BASE}/healthz`)).ok) return;
        } catch { /* not up yet */ }
        await sleep(100);
    }
    throw new Error('server did not start');
}
async function stopServer() {
    if (!serverProc) return;
    const proc = serverProc;
    serverProc = null;
    const exited = new Promise((r) => proc.once('exit', r));
    process.kill(proc.pid, 'SIGTERM');
    await exited;
}

// ---------- console error tracking ----------
const consoleErrors = [];
let restarting = false;
function watch(page, label) {
    page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        // While the server is down, Chromium logs failed WebSocket attempts. That's expected.
        if (restarting && /WebSocket connection|ERR_CONNECTION_REFUSED/.test(text)) return;
        consoleErrors.push(`${label}: ${text}`);
    });
    page.on('pageerror', (err) => consoleErrors.push(`${label}: ${err.message}`));
}

async function noHorizontalScroll(page, label) {
    const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
    assert.ok(scroll <= width, `${label} scrolls sideways (${scroll} > ${width})`);
}

// ---------- room flow ----------
async function newHost(browser, label) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    watch(page, label);
    return { context, page, label };
}

async function newPhone(browser, label) {
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    });
    const page = await context.newPage();
    watch(page, label);
    return { context, page, label };
}

const visible = (page, selector) => page.locator(selector).isVisible();

async function findActor(phones) {
    for (let i = 0; i < 100; i++) {
        for (const phone of phones) {
            if (await visible(phone.page, '#p-turn-ready')) return phone;
        }
        await sleep(100);
    }
    throw new Error('nobody is up');
}

// Taps "Got it" until `count` words are guessed or the round ends.
async function guess(phone, count = Infinity) {
    for (let n = 0; n < count; n++) {
        const turn = phone.page.locator('#p-turn');
        if (!(await turn.isVisible())) return n;
        const word = await phone.page.locator('#p-word').textContent();
        await phone.page.locator('#p-got:not([disabled])').click({ timeout: 5000 });
        // Wait until the card changes (or the turn screen goes away).
        await phone.page.waitForFunction(
            (prev) => document.getElementById('p-turn').classList.contains('hidden')
                || (document.getElementById('p-word').textContent !== prev && !document.getElementById('p-got').disabled),
            word, { timeout: 5000 },
        ).catch(() => {});
    }
    return count;
}

async function scoreTotal(host) {
    const a = Number(await host.page.locator('#h-score-a .score').textContent());
    const b = Number(await host.page.locator('#h-score-b .score').textContent());
    return a + b;
}

async function playRoom(browser, name, { shots, timeoutTurn }) {
    const host = await newHost(browser, `${name}-host`);
    await host.page.goto(BASE);
    await host.page.locator('[data-action=createGame]').first().click();
    await host.page.locator('#h-lobby').waitFor();
    const code = (await host.page.locator('#h-room-code').textContent()).trim();
    assert.match(code, /^[A-HJ-NP-Z]{4}$/);
    assert.equal(new URL(host.page.url()).search, `?host=${code}`);
    log(name, 'room', code);

    const phones = [];
    for (let i = 0; i < 4; i++) phones.push(await newPhone(browser, `${name}-phone${i}`));

    // Phone 0 types the code by hand, after a typo; the others scan the QR (open /CODE).
    const manual = phones[0].page;
    await manual.goto(BASE);
    await manual.locator('[data-action=joinGame]').click();
    const bad = code === 'ZZZZ' ? 'YYYY' : 'ZZZZ';
    await manual.locator('#p-code').fill(bad);
    await manual.locator('#p-code-status.error').waitFor();
    assert.match(await manual.locator('#p-code-status').textContent(), /no game with that code/i);
    await manual.locator('#p-name').fill(`${name} Ann`);
    await manual.locator('#p-join-form button[type=submit]').click();
    await manual.locator('#p-join-error').waitFor();
    assert.match(await manual.locator('#p-join-error').textContent(), /no game with that code/i);
    if (shots) await manual.screenshot({ path: `${SHOTS}/phone-bad-code.png` });
    await manual.locator('#p-code').fill(code.toLowerCase());
    await manual.locator('#p-code-status:not(.error)').waitFor();
    await manual.locator('#p-join-form button[type=submit]').click();
    await manual.locator('#p-lobby').waitFor();

    const names = ['Ann', 'Ben', 'Cat', 'Dan'];
    for (let i = 1; i < 4; i++) {
        const page = phones[i].page;
        await page.goto(`${BASE}/${code}`);
        await page.locator('#p-code-fixed').waitFor();
        if (shots && i === 1) await page.screenshot({ path: `${SHOTS}/phone-join.png` });
        await page.locator('#p-name').fill(`${name} ${names[i]}`);
        await page.locator('#p-join-form button[type=submit]').click();
        await page.locator('#p-lobby').waitFor();
    }
    for (const phone of phones) {
        assert.equal((await phone.page.locator('#p-room').textContent()).trim(), `Room ${code}`);
    }
    await host.page.waitForFunction(() => document.querySelectorAll('#h-lobby-players li:not(.empty)').length === 4);
    if (shots) {
        await host.page.screenshot({ path: `${SHOTS}/host-lobby.png` });
        await phones[1].page.screenshot({ path: `${SHOTS}/phone-lobby.png` });
    }

    // Settings: 30s turns, 2 words each.
    await host.page.locator('#set-timer').selectOption('30');
    await host.page.locator('#set-words').selectOption('2');
    await host.page.locator('#h-start').click();
    for (const [i, phone] of phones.entries()) {
        await phone.page.locator('#p-submit').waitFor();
        const inputs = phone.page.locator('.word-input');
        await inputs.nth(0).fill(`${name} word ${i}a`);
        await inputs.nth(1).fill(`${name} word ${i}b`);
        if (shots && i === 0) await phone.page.screenshot({ path: `${SHOTS}/phone-words.png` });
        await phone.page.locator('#p-submit-btn').click();
    }
    await host.page.locator('#h-ready').waitFor();
    if (shots) await host.page.screenshot({ path: `${SHOTS}/host-teams.png` });

    // ----- Round 1 -----
    await host.page.locator('#h-ready [data-host=startRound]').click();
    await host.page.locator('#h-game').waitFor();
    let actor = await findActor(phones);
    if (shots) await actor.page.screenshot({ path: `${SHOTS}/phone-turn-ready.png` });
    await actor.page.locator('[data-action=startTurn]').click();
    await actor.page.locator('#p-turn').waitFor();

    if (timeoutTurn) {
        // Let this turn run out, watching the countdown go down smoothly on the TV.
        const clock = host.page.locator('#h-clock');
        const first = Number(await clock.textContent());
        await sleep(1500);
        const second = Number(await clock.textContent());
        assert.ok(second < first && second >= first - 2, `clock counts down (${first} -> ${second})`);
        await host.page.locator('#h-clock.urgent').waitFor({ timeout: 25_000 });
        await host.page.screenshot({ path: `${SHOTS}/host-game-urgent.png` });
        await actor.page.screenshot({ path: `${SHOTS}/phone-turn-urgent.png` });
        await host.page.locator('#h-timesup:not(.hidden)').waitFor({ timeout: 15_000 });
        assert.match(await host.page.locator('#h-timesup').textContent(), /Time's up!/);
        await host.page.screenshot({ path: `${SHOTS}/host-times-up.png` });
        await actor.page.locator('#p-info').waitFor();
        actor = await findActor(phones);
        await actor.page.locator('[data-action=startTurn]').click();
        await actor.page.locator('#p-turn').waitFor();
        log(name, 'turn timed out on the server');
    } else {
        // Phone reload mid-turn: guess one, reload, keep going with the same card and clock.
        await guess(actor, 1);
        await sleep(1200);
        const before = Number((await actor.page.locator('#p-timer').textContent()).replace('s', ''));
        if (shots) {
            await actor.page.screenshot({ path: `${SHOTS}/phone-turn.png` });
            await host.page.screenshot({ path: `${SHOTS}/host-game.png` });
            const watcher = phones.find((p) => p !== actor);
            await watcher.page.screenshot({ path: `${SHOTS}/phone-watching.png` });
        }
        const word = await actor.page.locator('#p-word').textContent();
        await actor.page.reload();
        await actor.page.locator('#p-turn').waitFor();
        assert.equal(await actor.page.locator('#p-word').textContent(), word, 'same card after reload');
        const after = Number((await actor.page.locator('#p-timer').textContent()).replace('s', ''));
        assert.ok(after <= before && after > before - 5, `clock carried on (${before} -> ${after})`);
        log(name, `phone reloaded mid-turn, clock ${before}s -> ${after}s`);
    }
    await guess(actor);
    await host.page.locator('#h-roundover').waitFor();
    if (shots) await host.page.screenshot({ path: `${SHOTS}/host-round-over.png` });

    // ----- Round 2, with a host reload mid-round -----
    await host.page.locator('#h-next-round').click();
    await host.page.locator('#h-game').waitFor();
    actor = await findActor(phones);
    await actor.page.locator('[data-action=startTurn]').click();
    await actor.page.locator('#p-turn').waitFor();
    await guess(actor, 2);
    await host.page.waitForFunction(() => {
        const n = (id) => Number(document.querySelector(`#${id} .score`).textContent);
        return n('h-score-a') + n('h-score-b') === 10;
    });
    const total = await scoreTotal(host);
    await host.page.reload();
    await host.page.locator('#h-game').waitFor();
    assert.equal(new URL(host.page.url()).search, `?host=${code}`);
    assert.equal(await scoreTotal(host), total, 'same scores after host reload');
    assert.equal((await host.page.locator('#h-room-pill').textContent()).trim(), `Room ${code}`);
    log(name, 'host reloaded mid-round');
    await guess(actor);
    await host.page.locator('#h-roundover').waitFor();

    // ----- Round 3 -----
    await host.page.locator('#h-next-round').click();
    await host.page.locator('#h-game').waitFor();
    actor = await findActor(phones);
    await actor.page.locator('[data-action=startTurn]').click();
    await actor.page.locator('#p-turn').waitFor();
    await guess(actor);
    await host.page.locator('#h-gameover').waitFor();
    for (const phone of phones) await phone.page.locator('#p-info').waitFor();
    const final = await host.page.locator('#h-gameover-body').textContent();
    assert.match(final, /wins|tie/);
    if (shots) {
        await host.page.screenshot({ path: `${SHOTS}/host-game-over.png` });
        await phones[0].page.screenshot({ path: `${SHOTS}/phone-game-over.png` });
    }
    for (const phone of phones) await noHorizontalScroll(phone.page, phone.label);
    log(name, 'game over:', final.replace(/\s+/g, ' ').trim().slice(0, 60));
    return { name, code, host, phones };
}

(async () => {
    await startServer();
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
    try {
        const [one, two] = await Promise.all([
            playRoom(browser, 'red', { shots: true, timeoutTurn: false }),
            playRoom(browser, 'blue', { shots: false, timeoutTurn: true }),
        ]);
        assert.notEqual(one.code, two.code);

        // Room isolation, as the players see it: no names from the other room anywhere.
        const redText = await one.host.page.locator('body').textContent();
        assert.ok(!/blue (Ann|Ben|Cat|Dan)/.test(redText), 'red room shows blue players');

        // Room full (this run caps rooms at 4 players).
        const fifth = await newPhone(browser, 'red-phone5');
        await fifth.page.goto(`${BASE}/${one.code}`);
        await fifth.page.locator('#p-name').fill('Extra');
        await fifth.page.locator('#p-join-form button[type=submit]').click();
        await fifth.page.locator('#p-join-error').waitFor();
        assert.match(await fifth.page.locator('#p-join-error').textContent(), /full/);
        await fifth.page.screenshot({ path: `${SHOTS}/phone-room-full.png` });
        log('room full error shown');

        // The host drops out: phones wait for them, then the host comes back with its token.
        await two.host.page.close();
        await two.phones[0].page.locator('#host-banner:not(.hidden)').waitFor();
        assert.match(await two.phones[0].page.locator('#host-banner').textContent(), /Waiting for the host to come back/);
        await two.phones[0].page.screenshot({ path: `${SHOTS}/phone-host-away.png` });
        const hostAgain = await two.host.context.newPage();
        watch(hostAgain, 'blue-host-again');
        await hostAgain.goto(`${BASE}/?host=${two.code}`);
        await hostAgain.locator('#h-gameover').waitFor();
        await two.phones[0].page.locator('#host-banner.hidden').waitFor({ state: 'attached' });
        log('host left and came back');

        // Play again in the red room so a game is running when the server restarts.
        await one.host.page.locator('[data-host=playAgain]').click();
        await one.host.page.locator('#h-lobby').waitFor();
        await one.phones[0].page.locator('#p-lobby').waitFor();

        // Server restart: every screen should say so instead of hanging.
        restarting = true;
        await stopServer();
        await one.phones[1].page.locator('#conn-banner:not(.hidden)').waitFor();
        await startServer();
        const everyone = [one.host.page, hostAgain, ...one.phones.map((p) => p.page), ...two.phones.map((p) => p.page)];
        for (const page of everyone) {
            await page.getByText('This game ended because the server restarted').waitFor({ timeout: 20_000 });
        }
        restarting = false;
        await one.host.page.screenshot({ path: `${SHOTS}/host-server-restarted.png` });
        await one.phones[0].page.screenshot({ path: `${SHOTS}/phone-server-restarted.png` });
        await one.phones[0].page.locator('#p-ended [data-action=backToStart]').click();
        await one.phones[0].page.locator('#landing').waitFor();
        await one.host.page.locator('#h-ended [data-action=backToStart]').click();
        await one.host.page.locator('#landing').waitFor();
        await one.host.page.screenshot({ path: `${SHOTS}/landing.png` });
        log('server restart handled on all screens');

        // A new game works on the restarted server.
        await one.host.page.locator('[data-action=createGame]').first().click();
        await one.host.page.locator('#h-lobby').waitFor();
        log('new room after restart:', await one.host.page.locator('#h-room-code').textContent());

        assert.deepEqual(consoleErrors, [], 'console errors');
        log('PASS: no console errors, screenshots in', SHOTS);
    } finally {
        await browser.close();
        await stopServer();
    }
})().catch(async (err) => {
    console.error('FAIL:', err);
    if (consoleErrors.length) console.error('Console errors:', consoleErrors);
    if (serverProc) process.kill(serverProc.pid, 'SIGTERM');
    process.exit(1);
});
