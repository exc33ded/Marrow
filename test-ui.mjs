// Browser check: every look, in light and dark, on every screen. Needs Playwright and a running server:
//   npm i --no-save playwright && npx playwright install chromium
//   npm start &   then   npm run test:ui        (BASE=http://localhost:5173 by default)
// Looks are found from index.html, so a look someone adds is covered without editing this file.
// In CI (CI=true) it also creates one notebook page to exercise the editor. Locally it writes nothing.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:5173';
const VIEWS = ['home', 'library', 'discover', 'review', 'matrix', 'notebook', 'map', 'settings'];
const html = await (await fetch(BASE)).text();
const looks = ['', ...new Set([...html.matchAll(/(?<![\w\]])\[data-look=([\w-]+)\]/g)].map(m => m[1]))];
const problems = [];
const bad = (where, msg) => problems.push(`${where}: ${msg}`);

// Colour maths in the page, so the colours are the ones really rendered (color-mix, var() and all).
const probe = () => {
  const cx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  const rgb = c => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); return [...cx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
  const lum = a => a.map(v => (v /= 255) <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
  const cr = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
  const el = document.body.appendChild(document.createElement('div'));
  const bg = t => { el.style.background = `var(${t})`; return rgb(getComputedStyle(el).backgroundColor); };
  const fg = t => { el.style.color = `var(${t})`; return rgb(getComputedStyle(el).color); };
  const out = { text: {}, heat: {} };
  for (const [a, b, kind] of [['--ink', '--panel', 'fg'], ['--ink', '--bg', 'fg'], ['--muted', '--panel', 'fg'], ['--acc', '--panel', 'fg'], ['--on-pri', '--pri', 'fg']]) out.text[`${a} on ${b}`] = cr(fg(a), bg(b));
  out.heat.emptyOnBg = cr(bg('--h0'), bg('--bg'));
  const cell = document.querySelector('.hg i');
  if (cell) { const s = getComputedStyle(cell); out.heat.outlined = parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none' || parseFloat(s.outlineWidth) > 0 && s.outlineStyle !== 'none' || s.boxShadow !== 'none'; }
  out.heat.levels = [...document.querySelectorAll('.hleg i')].map(i => { const s = getComputedStyle(i); return s.backgroundColor + '|' + s.backgroundImage; });
  el.remove(); return out;
};

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL }); // PW_CHANNEL=chrome uses an installed Chrome
for (const look of looks) for (const theme of ['light', 'dark']) {
  const tag = `${look || 'notebook'}/${theme}`;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => bad(tag, 'script error: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|favicon/.test(m.text())) bad(tag, 'console error: ' + m.text()); });
  await page.goto(`${BASE}/?look=${look}&theme=${theme}`); // always send look, so an empty one means the original rather than the default
  await page.waitForSelector('#nav button');
  const applied = await page.evaluate(() => document.documentElement.dataset.look || '');
  if (applied !== look) bad(tag, `look did not apply (data-look is "${applied}")`);

  for (const v of VIEWS) {
    await page.evaluate(v => document.querySelector(`[data-view=${v}]`).click(), v); // a phone folds the rail away, so go straight to the view
    await page.waitForTimeout(450); // let the entrance animation finish
    if (process.env.CI && v === 'notebook') { await page.click('[data-act=nbnew]').catch(() => {}); await page.waitForSelector('.ttl', { timeout: 4000 }).catch(() => bad(tag, 'notebook page did not open')); await page.waitForTimeout(500); }
    const over = await page.evaluate(() => { const p = document.querySelector('#page'); return p ? p.scrollWidth - p.clientWidth : 0; });
    if (over > 1) bad(tag, `${v}: content is ${over}px wider than the screen`);
    if (v === 'home') {
      const r = await page.evaluate(probe);
      for (const [pair, ratio] of Object.entries(r.text)) if (ratio < 4.5) bad(tag, `${pair} is ${ratio.toFixed(2)}:1, needs 4.5:1`);
      if (r.heat.emptyOnBg < 1.25 && !r.heat.outlined) bad(tag, `empty activity squares are almost invisible (${r.heat.emptyOnBg.toFixed(2)}:1 and no outline)`);
      if (new Set(r.heat.levels).size < 5) bad(tag, 'the five activity levels are not all distinct');
      const cells = await page.$$('.hg i');
      if (cells.length) {
        await cells[cells.length - 1].hover();
        const box = await page.evaluate(() => { const t = document.querySelector('#heattip'); if (!t || t.hidden) return null; const b = t.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: innerWidth }; });
        if (!box) bad(tag, 'hovering an activity square shows no history');
        else if (box.l < 0 || box.t < 0 || box.r > box.w) bad(tag, 'the activity tooltip runs off the screen');
      }
    }
  }
  // a phone: nothing should push the page wider than the screen
  await page.setViewportSize({ width: 390, height: 844 });
  for (const v of ['home', 'settings']) {
    await page.evaluate(v => document.querySelector(`[data-view=${v}]`).click(), v); await page.waitForTimeout(450);
    const over = await page.evaluate(() => { const p = document.querySelector('#page'); return p ? p.scrollWidth - p.clientWidth : 0; });
    if (over > 1) bad(tag + ' (phone)', `${v}: content is ${over}px wider than the screen`);
  }
  await page.context().close();
}
await browser.close();

if (problems.length) { console.error(`ui check failed (${problems.length}):\n - ` + problems.join('\n - ')); process.exit(1); }
console.log(`ui check passed (${looks.length} looks x light/dark x ${VIEWS.length} screens)`);
