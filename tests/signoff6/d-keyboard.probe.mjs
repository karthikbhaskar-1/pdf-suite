// Probe D: keyboard only (no mouse after the file is open), plus the wording of tooltips, labels and messages.
import {
  launch, closeAll, open, palette, waitForCount, saveNow, isDirty, delay, pageCount, waitFor, newFile, wipe, report, buildPdf, content, readPages, expectedImages, compare, sheetOf,
} from './lib.mjs';

const R = report('d-keyboard');
const f = newFile('kb.pdf', buildPdf([1, 2, 3].map((n) => ({ media: [0, 0, 800, 500], content: content(`K${n}`) }))));
const s = await launch();
const key = (k) => s.win.keyboard.press(k);
const active = () => s.win.evaluate(() => {
  const a = document.activeElement;
  if (!a) return 'none';
  const lab = a.getAttribute('aria-label') || (a.labels && a.labels[0]?.textContent) || a.textContent?.trim().slice(0, 30) || '';
  return `${a.tagName.toLowerCase()}${a.getAttribute('role') ? '[' + a.getAttribute('role') + ']' : ''}${a.type ? '(' + a.type + ')' : ''} "${lab}"${a.checked ? ' checked' : ''}`;
});
try {
  await s.win.waitForSelector('.empty-state');
  await open(s, f.path, 3);
  const o = readPages(f.path);

  // wording of entry points
  const btn = s.win.getByRole('toolbar', { name: 'Toolbar' }).getByRole('button', { name: 'Cut pages in half' });
  R.say(`INFO  toolbar button title="${await btn.getAttribute('title')}" aria-label="${await btn.getAttribute('aria-label')}"`);
  await btn.hover();
  await delay(1500);
  const tips = await s.win.locator('[role="tooltip"], .tooltip').allInnerTexts();
  R.say(`INFO  tooltip after hover: ${JSON.stringify(tips)}`);
  R.check('toolbar button tooltip or title reads "Cut pages in half"', /Cut pages in half/.test((await btn.getAttribute('title')) ?? '') || tips.some((t) => /Cut pages in half/.test(t)));
  await s.win.mouse.move(5, 5);

  // open by keyboard
  await palette(s.win, 'Pages: Cut pages in half');
  await sheetOf(s.win).waitFor({ timeout: 10000 });
  const sheet = sheetOf(s.win);
  await delay(300);
  const first = await active();
  R.say(`INFO  focus on open: ${first}`);
  R.check('focus on open is Cut into (Left and right radio)', /Left and right/.test(first), first);
  R.say(`INFO  hint text: "${(await sheet.innerText()).replace(/\n+/g, ' | ')}"`);
  R.check('sheet shows "Choose Right page first for books read right to left."', (await sheet.innerText()).includes('Choose Right page first for books read right to left.'));
  R.check('slider labelled "Cut position, percent of the page width"', (await sheet.getByRole('slider').getAttribute('aria-label')) === 'Cut position, percent of the page width');

  // Cut into: arrows
  await key('ArrowRight');
  await delay(200);
  R.say(`INFO  after ArrowRight on Cut into: focus ${await active()}; Top and bottom checked=${await sheet.getByRole('radio', { name: 'Top and bottom' }).isChecked()}`);
  R.check('Arrow right on Cut into selects Top and bottom (radio-group convention)', await sheet.getByRole('radio', { name: 'Top and bottom' }).isChecked());
  await key('Tab');
  await key('Space');
  await delay(200);
  R.check('Tab then Space selects Top and bottom', await sheet.getByRole('radio', { name: 'Top and bottom' }).isChecked(), await active());
  R.check('slider label follows: "...percent of the page height"', (await sheet.getByRole('slider').getAttribute('aria-label')) === 'Cut position, percent of the page height');
  R.check('Page order is hidden for Top and bottom', (await sheet.getByRole('radio', { name: 'Right page first' }).count()) === 0);
  await key('Shift+Tab'); await key('Space'); await delay(200);
  R.say(`INFO  Shift+Tab then Space: focus ${await active()}, Left and right checked=${await sheet.getByRole('radio', { name: 'Left and right' }).isChecked()}`);
  R.check('can return to Left and right by keyboard', await sheet.getByRole('radio', { name: 'Left and right' }).isChecked());

  // Tab order record
  const order = [];
  for (let i = 0; i < 9; i++) { await key('Tab'); order.push(await active()); }
  R.say('INFO  (tab order is recorded from wherever focus was)');
  R.say(`INFO  tab order after Cut into: ${order.join('  ->  ')}`);
  // find slider: go back with shift+tab until the slider has focus
  for (let i = 0; i < 12 && !/range/.test(await active()); i++) await key(i < 9 ? 'Shift+Tab' : 'Tab');
  const onSlider = await active();
  R.check('can reach the slider by keyboard', /range|slider/.test(onSlider), onSlider);
  const val = () => sheet.getByLabel('Cut position in percent').inputValue();
  const steps = [['Home', '30'], ['End', '70'], ['Home', '30'], ['PageUp', '35'], ['ArrowRight', '35.5'], ['ArrowLeft', '35'], ['PageDown', '30'], ['End', '70'], ['PageDown', '65'], ['ArrowLeft', '64.5']];
  for (const [k, expect] of steps) {
    await key(k);
    await delay(120);
    R.check(`slider ${k} -> ${expect}`, (await val()) === expect, `got ${await val()}`);
  }
  // the box
  await key('Tab');
  const onBox = await active();
  R.check('Tab from the slider reaches the percent box', /Cut position in percent/.test(onBox), onBox);
  await key('Control+a');
  await s.win.keyboard.type('45');
  await delay(150);
  R.check('typing in the box sets 45 and the slider follows', (await val()) === '45' && (await sheet.getByRole('slider').inputValue()) === '45');
  await key('Tab');
  const onCentre = await active();
  R.check('next Tab reaches the Centre button', /Center/.test(onCentre), onCentre);
  await key('Enter');
  await delay(150);
  R.check('Enter on Centre sets 50', (await val()) === '50', await val());
  await key('Space').catch(() => undefined);
  // type 40 again
  await key('Shift+Tab'); await key('Control+a'); await s.win.keyboard.type('40');
  await key('Tab'); await key('Tab');
  const onOrder = await active();
  R.say(`INFO  after Centre: ${onOrder}`);
  // Page order radios
  if (!/Left page first|Right page first/.test(onOrder)) R.check('Tab after Centre reaches Page order', false, onOrder);
  else {
    await key('Tab');
    await key('Space');
    await delay(150);
    R.check('Right page first chosen by keyboard (Tab, Space)', await sheet.getByRole('radio', { name: 'Right page first' }).isChecked(), await active());
  }
  await key('Tab');
  const onApplyTo = await active();
  R.say(`INFO  next stop: ${onApplyTo}`);
  R.check('next Tab reaches "Apply to"', /Apply to|select/.test(onApplyTo), onApplyTo);
  const options = await sheet.getByLabel('Apply to').evaluate((el) => [...el.options].map((o) => `${o.value}:${o.textContent}`));
  R.say(`INFO  Apply to options: ${options.join(' | ')}; current value ${await sheet.getByLabel('Apply to').inputValue()}`);
  // pick "Current page" by keyboard: type its first letter
  await s.win.keyboard.type('C');
  await delay(200);
  const scope = await sheet.getByLabel('Apply to').inputValue();
  R.check('typing C in Apply to chooses Current page', scope === 'current', scope);
  R.say(`INFO  summary: "${await sheet.locator('[data-cut-summary]').innerText()}"`);
  R.check('summary reads "Cuts 1 page into 2. Comments and links stay with their half."', (await sheet.locator('[data-cut-summary]').innerText()).trim() === 'Cuts 1 page into 2. Comments and links stay with their half.');
  await key('Tab');
  const t1 = await active();
  await key('Tab');
  const t2 = await active();
  R.say(`INFO  then: ${t1} -> ${t2}`);
  R.check('Cancel then Apply follow, in that order', /Cancel/.test(t1) && /Apply/.test(t2), `${t1} / ${t2}`);
  await key('Enter');
  await sheet.waitFor({ state: 'detached', timeout: 20000 });
  await waitForCount(s.win, 4);
  const toast = await s.win.locator('.toast').first().innerText();
  R.say(`INFO  toast: ${JSON.stringify(toast)}`);
  R.check('toast reads "Cut 1 page in half" with Undo', /^Cut 1 page in half/.test(toast.trim()) && /Undo/.test(toast), toast);
  await s.win.getByRole('menubar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
  const undoText = (await s.win.locator('.menu-dropdown').last().locator('[role="menuitem"]').first().innerText()).replace(/\s+/g, ' ');
  await key('Escape');
  R.check('Edit menu says "Undo Cut 1 page in half"', /Undo Cut 1 page in half/.test(undoText), undoText);
  await saveNow(s.win);
  const exp = expectedImages(o, [{ cut: 'vertical', at: 0.4, first: 'right' }, null, null]);
  const { problems } = compare(f.path, exp);
  R.check('keyboard-only cut: file has page 1 cut at 40 % right first, pages 2 and 3 untouched', problems.length === 0, problems.join('; '));

  // Esc closes the sheet and where does focus go
  await palette(s.win, 'Pages: Cut pages in half');
  await sheetOf(s.win).waitFor({ timeout: 10000 });
  await key('Escape');
  await sheetOf(s.win).waitFor({ state: 'detached', timeout: 5000 });
  R.say(`INFO  focus after Esc: ${await active()}`);
  // Esc inside the percent box with bad text
  await palette(s.win, 'Pages: Cut pages in half');
  await sheetOf(s.win).waitFor({ timeout: 10000 });
  await sheetOf(s.win).getByLabel('Cut position in percent').focus();
  await key('Control+a'); await s.win.keyboard.type('abc');
  await key('Enter');
  await delay(500);
  R.check('Enter in the percent box with bad text does not apply (sheet stays, 4 pages)', (await sheetOf(s.win).count()) === 1 && (await pageCount(s.win)) === 4);
  await key('Escape');
  await delay(400);
  R.check('Esc closes the sheet from the percent box', (await sheetOf(s.win).count()) === 0 && !(await isDirty(s.win)));
  // menu entry keyboard
  await s.win.keyboard.press('Alt+p').catch(() => undefined);
  await delay(400);
  const dd = s.win.locator('.menu-dropdown').last();
  if (await dd.count()) {
    const label = (await dd.getByRole('menuitem', { name: /^Cut Pages in Half…/ }).first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    R.say(`INFO  Pages menu entry: "${label}"`);
    R.check('Pages menu entry reads "Cut Pages in Half…"', /^Cut Pages in Half…/.test(label), label);
    await key('Escape');
  } else R.say('INFO  Alt+P did not open the Pages menu (not checked)');
  const errs = s.errors.filter((e) => !/favicon/.test(e));
  R.check('no console or page errors', errs.length === 0, errs.slice(0, 3).join(' | ').slice(0, 300));
} finally {
  await s.close();
}
const failed = R.summary();
await closeAll();
wipe();
process.exit(failed ? 1 : 0);
