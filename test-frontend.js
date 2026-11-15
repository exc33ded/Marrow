// Frontend contract: no dependencies, no browser. Run with `node test-frontend.js`.
// It finds every look in index.html by itself, so a look someone adds is checked without editing this file.
const fs = require('fs'), assert = require('assert'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const html = fs.readFileSync(process.argv[2] || path.join(__dirname, 'index.html'), 'utf8'); // optional path, so the check can be pointed at a file under test
const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
const problems = [];
const need = (ok, msg) => { if (!ok) problems.push(msg); };

// 1. The app's script parses.
const mod = html.match(/<script type="module">([\s\S]*?)<\/script>/);
assert(mod, 'index.html has no module script');
const tmp = path.join(os.tmpdir(), 'marrow-module-check.mjs');
fs.writeFileSync(tmp, mod[1].replace(/^import .*$/mg, ''));
try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); } catch (e) { need(false, 'the app script does not parse:\n' + e.stderr); }

// 2. Every look defines the whole token set, in light and in dark.
const TOKENS = ['--bg', '--panel', '--ink', '--muted', '--line', '--acc', '--acc-bg', '--ok', '--pdf', '--web', '--vid', '--sh', '--pop', '--pri', '--pri-h', '--on-pri', '--on-n', '--scrim', '--logo-a', '--logo-b', '--f-body', '--f-display', '--f-mono', '--r', '--r2', '--sig', '--h0', '--h1', '--h2', '--h3', '--h4'];
const decls = body => Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)].map(m => [m[1], m[2]]));
const merge = re => Object.assign({}, ...[...css.matchAll(re)].map(m => decls(m[1])));
const looks = { notebook: { light: merge(/(?<![\w\]-]):root\s*\{([^}]*)\}/g), dark: merge(/(?<![\w\]-])\[data-theme=dark\]\s*\{([^}]*)\}/g) } };
for (const name of new Set([...css.matchAll(/(?<![\w\]])\[data-look=([\w-]+)\]/g)].map(m => m[1]))) {
  looks[name] = {
    light: merge(new RegExp(String.raw`(?<![\w\]])\[data-look=${name}\]\s*\{([^}]*)\}`, 'g')),
    dark: merge(new RegExp(String.raw`(?<![\w\]])\[data-look=${name}\]\[data-theme=dark\]\s*\{([^}]*)\}`, 'g')),
  };
}
// Light defines everything. Dark inherits fonts and radii from light but must restate every colour, because a look's light colours would otherwise win in dark.
const SHARED = ['--f-body', '--f-display', '--f-mono', '--r', '--r2'];
for (const [name, modes] of Object.entries(looks)) for (const [mode, t] of Object.entries(modes)) {
  if (name === 'notebook' && mode === 'dark') continue; // the original look: dark only overrides what differs
  const miss = TOKENS.filter(k => !(k in t) && !(mode === 'dark' && SHARED.includes(k)));
  need(!miss.length, `look "${name}" (${mode}) is missing ${miss.join(', ')}`);
}

// 3. The picker lists exactly the looks that exist.
const registry = (html.match(/const LOOKS = (\[\[[\s\S]*?\]\]);/) || [])[1];
need(registry, 'the LOOKS list is missing from index.html');
const names = registry ? [...registry.matchAll(/\['([\w-]*)',/g)].map(m => m[1]).filter(Boolean) : [];
for (const n of Object.keys(looks).filter(n => n !== 'notebook')) need(names.includes(n), `look "${n}" has styles but is not in the LOOKS list, so it cannot be picked`);
for (const n of names) need(looks[n], `LOOKS lists "${n}" but no [data-look=${n}] styles exist`);

// 4. Fonts: the first family of every font token is a system font or is in the Google Fonts request.
const SYSTEM = /^(ui-sans-serif|ui-serif|ui-monospace|system-ui|-apple-system|blinkmacsystemfont|segoe ui|helvetica|arial|georgia|iowan old style|sfmono-regular|menlo|consolas|sans-serif|serif|monospace)$/i;
const fontLink = decodeURIComponent((html.match(/fonts\.googleapis\.com\/css2\?([^"]+)"/) || [])[1] || '').replace(/\+/g, ' ');
for (const [name, modes] of Object.entries(looks)) for (const k of ['--f-body', '--f-display', '--f-mono']) {
  const first = (modes.light[k] || '').split(',')[0].replace(/["']/g, '').trim();
  if (first && !first.startsWith('var(')) need(SYSTEM.test(first) || fontLink.includes('family=' + first), `look "${name}" sets ${k} to "${first}", which is neither a system font nor in the Google Fonts link`);
}

// 5. Text is readable. Only tokens written as plain hex can be checked here; the browser test checks every look as rendered.
const hex = v => { const m = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec((v || '').trim()); if (!m) return null; const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1]; return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
const lum = ([r, g, b]) => [r, g, b].map(v => (v /= 255) <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((a, v, i) => a + v * [.2126, .7152, .0722][i], 0);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
const PAIRS = [['--ink', '--panel'], ['--ink', '--bg'], ['--muted', '--panel'], ['--acc', '--panel'], ['--on-pri', '--pri']];
for (const [name, modes] of Object.entries(looks)) for (const [mode, t] of Object.entries(modes)) for (const [fg, bg] of PAIRS) {
  const a = hex(t[fg]), b = hex(t[bg]); if (!a || !b) continue;
  need(ratio(a, b) >= 4.5, `look "${name}" (${mode}): ${fg} on ${bg} is ${ratio(a, b).toFixed(2)}:1, needs 4.5:1`);
}

if (problems.length) { console.error('frontend check failed:\n - ' + problems.join('\n - ')); process.exit(1); }
console.log(`frontend check passed (${Object.keys(looks).length} looks: ${Object.keys(looks).join(', ')})`);
