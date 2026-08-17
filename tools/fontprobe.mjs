#!/usr/bin/env node
/** Which font families actually resolve in the capture browser. */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');
const out = await page.evaluate(() => {
  const families = [
    'DIN Condensed', 'DIN Condensed Bold', 'DIN Alternate', 'Oswald', 'Rajdhani',
    'Impact', 'Haettenschweiler', 'Arial Narrow', 'Avenir Next Condensed',
    'Helvetica Neue', 'SF Compact', 'Menlo', 'Futura', 'Gill Sans',
    'PT Sans Narrow', 'Roboto Condensed', 'Barlow Condensed', 'Bebas Neue',
    'Trebuchet MS', 'Tahoma', 'Verdana', 'Geneva'
  ];
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const probe = 'HAMBURGEFONS 0123456789';
  const baselines = {};
  for (const generic of ['monospace', 'serif', 'sans-serif']) {
    ctx.font = `72px ${generic}`;
    baselines[generic] = ctx.measureText(probe).width;
  }
  const result = {};
  for (const family of families) {
    let available = false;
    for (const generic of ['monospace', 'serif', 'sans-serif']) {
      ctx.font = `72px "${family}", ${generic}`;
      if (Math.abs(ctx.measureText(probe).width - baselines[generic]) > 0.5) {
        available = true;
        break;
      }
    }
    ctx.font = `72px "${family}", sans-serif`;
    result[family] = { available, width: +ctx.measureText(probe).width.toFixed(1) };
  }
  result.__baselines = baselines;
  return result;
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
