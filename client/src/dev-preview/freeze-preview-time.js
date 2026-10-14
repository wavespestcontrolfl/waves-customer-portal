// DEV HARNESS: the lawn layout preview shows a visit that finished at 10:56 AM ET on Oct 9, 2026, with
// its watering note live and its re-entry time still ahead. Freezing "now" at 11:10 AM ET that day
// keeps the saved payloads and the page in step, whenever the preview is opened. Must be the first import.
const FIXED_NOW = Date.parse('2026-10-09T15:10:00.000Z');
const RealDate = Date;

class PreviewDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FIXED_NOW);
    else super(...args);
  }

  static now() { return FIXED_NOW; }
}

window.Date = PreviewDate;
