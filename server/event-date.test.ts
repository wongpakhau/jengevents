import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { normalizeEventDate } from "../shared/event-date";
import {
  eventDateFields,
  eventDateFromFields,
  eventDateUpdateFromFields,
  formatEventDate,
  formatEventVenue,
  isLegacyEventDateTime,
} from "../client/src/lib/event-date";

describe("event calendar date and time", () => {
  it("keeps valid date-only values and rejects impossible or ambiguous dates", () => {
    expect(normalizeEventDate("2027-01-31")).toBe("2027-01-31");
    expect(normalizeEventDate("2024-02-29")).toBe("2024-02-29");
    for (const date of [
      "2027-02-29",
      "2027-02-30",
      "2027-13-01",
      "2027-1-31",
      "2027/01/31",
      "2027-02-30T18:30:00Z",
    ]) {
      expect(normalizeEventDate(date)).toBeNull();
    }
  });

  it("preserves ISO datetimes as real instants, including explicit timezone offsets", () => {
    expect(normalizeEventDate("2027-01-31T18:30:00+08:00")).toBe(
      "2027-01-31T10:30:00.000Z"
    );
    expect(normalizeEventDate("2027-01-31T10:30:15.456Z")).toBe(
      "2027-01-31T10:30:15.456Z"
    );
    expect(normalizeEventDate("2027-01-31t18:30+0800")).toBe(
      "2027-01-31T10:30:00.000Z"
    );
    expect(normalizeEventDate("2027-01-31T05:30:00-05:00")).toBe(
      "2027-01-31T10:30:00.000Z"
    );
    for (const value of [
      "2027-01-31T18:30",
      "2027-01-31T18:30:00",
      "2027-01-31t18:30:00.123",
      "2027-01-31T18:30+08",
      "2027-01-31T18:30+08:60",
    ])
      expect(normalizeEventDate(value)).toBeNull();
    expect(normalizeEventDate("2027-01-31T25:30Z")).toBeNull();
  });

  it("shows explicitly pending time and venue and avoids invalid date rollover", () => {
    expect(formatEventDate("2027-01-31")).toBe("2027-01-31 · 時間待定");
    expect(formatEventDate("2027-02-30")).toBe("日期待定 · 時間待定");
    expect(formatEventVenue(" \t ")).toBe("場地待定");
    expect(formatEventVenue(" 主會場 ")).toBe("主會場");
    expect(formatEventDate("2027-01-31T10:30:00.000Z")).not.toContain(
      "時間待定"
    );
  });

  it("round-trips an untouched ISO instant exactly and allows adding and clearing a time", () => {
    const original = "2027-01-31T10:30:15.456Z";
    const fields = eventDateFields(original);
    expect(eventDateFromFields(fields, original)).toBe(original);
    expect(
      eventDateFromFields({ date: "2027-01-31", time: "" }, original)
    ).toBe("2027-01-31");
    const dated = eventDateFromFields(
      { date: "2027-01-31", time: "18:30" },
      "2027-01-31"
    );
    expect(dated).toMatch(/^2027-.*Z$/);
    expect(eventDateFields(dated!)).toEqual({
      date: "2027-01-31",
      time: "18:30",
    });
    expect(eventDateFromFields({ date: "2027-02-30", time: "" })).toBeNull();
    expect(
      eventDateFromFields({ date: "2027-01-31", time: "25:30" })
    ).toBeNull();
  });

  it("treats an explicitly selected midnight as a time, not as pending", () => {
    const saved = eventDateFromFields({ date: "2027-01-31", time: "00:00" });
    expect(saved).not.toBeNull();
    expect(saved).not.toBe("2027-01-31");
    expect(eventDateFields(saved!)).toEqual({
      date: "2027-01-31",
      time: "00:00",
    });
    expect(formatEventDate(saved!)).not.toContain("時間待定");
  });

  it("keeps legacy wall times readable without pretending they are instants", () => {
    const legacy = "2027-01-31T18:30:15.1000";
    const fields = eventDateFields(legacy);
    expect(isLegacyEventDateTime(legacy)).toBe(true);
    expect(isLegacyEventDateTime("2027-01-31T18:30:00Z")).toBe(false);
    expect(fields).toEqual({ date: "2027-01-31", time: "18:30:15.100" });
    expect(formatEventDate(legacy)).toBe(
      "2027-01-31 18:30:15.100 · 時區未指定"
    );
    expect(
      eventDateUpdateFromFields({ ...fields, time: "18:30:15.1" }, legacy)
    ).toEqual({});
    expect(eventDateUpdateFromFields({ ...fields, time: "" }, legacy)).toEqual({
      date: "2027-01-31",
    });
    const confirmed = eventDateUpdateFromFields(fields, legacy, true);
    expect(confirmed?.date).toMatch(/Z$/);
    expect(eventDateFields(confirmed!.date!)).toEqual(fields);
    const changed = eventDateUpdateFromFields(
      { ...fields, time: "18:31" },
      legacy
    );
    expect(changed?.date).toMatch(/Z$/);
    expect(eventDateFields(changed!.date!)).toEqual({
      date: "2027-01-31",
      time: "18:31",
    });
    expect(eventDateFromFields(fields, legacy)).toMatch(/Z$/);
  });

  it("retains legacy ISO 24:00 as the next calendar midnight without a timezone", () => {
    const legacy = "2027-01-31T24:00:00.000";
    const fields = { date: "2027-02-01", time: "00:00" };
    expect(eventDateFields(legacy)).toEqual(fields);
    expect(formatEventDate(legacy)).toBe("2027-02-01 00:00 · 時區未指定");
    expect(eventDateUpdateFromFields(fields, legacy)).toEqual({});
    expect(eventDateUpdateFromFields(fields, legacy, true)?.date).toMatch(/Z$/);
    expect(isLegacyEventDateTime("2027-01-31T24:01")).toBe(false);
  });

  it.each([
    ["UTC", "10:30", "GMT+0", "10:30", "GMT+0"],
    ["Asia/Hong_Kong", "18:30", "GMT+8", "18:30", "GMT+8"],
    ["America/New_York", "05:30", "GMT-5", "06:30", "GMT-4"],
    ["Asia/Kathmandu", "16:15", "GMT+5:45", "16:15", "GMT+5:45"],
    ["Pacific/Kiritimati", "00:30", "GMT+14", "00:30", "GMT+14"],
  ])(
    "uses the instant's local offset and DST in %s",
    (tz, winterTime, winterOffset, summerTime, summerOffset) => {
      const script = `import {normalizeEventDate} from './shared/event-date.ts';
      import {eventDateFields,eventDateFromFields,eventDateUpdateFromFields,formatEventDate} from './client/src/lib/event-date.ts';
      const winter='2027-01-31T10:30:00Z', summer='2027-07-31T10:30:00Z';
      const legacy='2027-03-14T02:30:00';
      console.log(JSON.stringify({
        winter: {fields:eventDateFields(winter), shown:formatEventDate(winter)},
        summer: {fields:eventDateFields(summer), shown:formatEventDate(summer)},
        dateOnly:formatEventDate('2027-01-31'),
        legacy: {fields:eventDateFields(legacy), shown:formatEventDate(legacy), update:eventDateUpdateFromFields(eventDateFields(legacy),legacy)},
        rejected:normalizeEventDate('2027-01-31T18:30'),
        zoned:normalizeEventDate('2027-01-31T18:30+08:00'),
        fromForm:eventDateFromFields({date:'2027-01-31',time:'18:30'}),
        confirmed:eventDateUpdateFromFields({date:'2027-01-31',time:'18:30'},'2027-01-31T18:30',true),
        confirmedGap:eventDateUpdateFromFields(eventDateFields(legacy),legacy,true)
      }));`;
      const result = JSON.parse(
        execFileSync(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", script],
          {
            cwd: process.cwd(),
            env: { ...process.env, TZ: tz },
            encoding: "utf8",
          }
        )
      );
      expect(result.winter.fields.time).toBe(winterTime);
      expect(result.winter.shown).toContain(`瀏覽器當地時間 ${winterOffset}`);
      expect(result.summer.fields.time).toBe(summerTime);
      expect(result.summer.shown).toContain(`瀏覽器當地時間 ${summerOffset}`);
      expect(result.dateOnly).toBe("2027-01-31 · 時間待定");
      expect(result.dateOnly).not.toContain("GMT");
      expect(result.legacy).toEqual({
        fields: { date: "2027-03-14", time: "02:30" },
        shown: "2027-03-14 02:30 · 時區未指定",
        update: {},
      });
      expect(result.rejected).toBeNull();
      expect(result.zoned).toBe("2027-01-31T10:30:00.000Z");
      expect(result.fromForm).toMatch(/Z$/);
      expect(result.confirmed).toEqual({ date: result.fromForm });
      if (tz === "America/New_York") expect(result.confirmedGap).toBeNull();
      if (tz === "Pacific/Kiritimati") {
        expect(result.winter.fields.date).toBe("2027-02-01");
        expect(result.summer.fields.date).toBe("2027-08-01");
      }
    }
  );

  it("labels both occurrences of a repeated DST hour with the correct offset", () => {
    const script = `import {formatEventDate,eventDateFields} from './client/src/lib/event-date.ts';
      console.log(JSON.stringify(['2027-11-07T05:30:00Z','2027-11-07T06:30:00Z'].map(v => ({fields:eventDateFields(v),shown:formatEventDate(v)}))));`;
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          cwd: process.cwd(),
          env: { ...process.env, TZ: "America/New_York" },
          encoding: "utf8",
        }
      )
    );
    expect(result[0].fields).toEqual({ date: "2027-11-07", time: "01:30" });
    expect(result[1].fields).toEqual(result[0].fields);
    expect(result[0].shown).toContain("GMT-4");
    expect(result[1].shown).toContain("GMT-5");
  });

  it.each([
    "UTC",
    "America/Los_Angeles",
    "Asia/Hong_Kong",
    "Pacific/Kiritimati",
  ])(
    "keeps 2027-01-31 unchanged through rendering and form saves in %s",
    tz => {
      const script = `import {eventDateFields, eventDateFromFields, formatEventDate} from './client/src/lib/event-date.ts';
        const value = '2027-01-31';
        const fields = eventDateFields(value);
        console.log(JSON.stringify({fields, saved: eventDateFromFields(fields, value), shown: formatEventDate(value), timed: eventDateFromFields({date: value, time: '18:30'})}));`;
      const result = JSON.parse(
        execFileSync(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", script],
          {
            cwd: process.cwd(),
            env: { ...process.env, TZ: tz },
            encoding: "utf8",
          }
        )
      );
      expect(result.fields).toEqual({ date: "2027-01-31", time: "" });
      expect(result.saved).toBe("2027-01-31");
      expect(result.shown).toBe("2027-01-31 · 時間待定");
      const expected: Record<string, string> = {
        UTC: "2027-01-31T18:30:00.000Z",
        "America/Los_Angeles": "2027-02-01T02:30:00.000Z",
        "Asia/Hong_Kong": "2027-01-31T10:30:00.000Z",
        "Pacific/Kiritimati": "2027-01-31T04:30:00.000Z",
      };
      expect(result.timed).toBe(expected[tz]);
    }
  );

  it("rejects a nonexistent local time instead of silently moving it", () => {
    const script = `import {eventDateFromFields} from './client/src/lib/event-date.ts'; console.log(JSON.stringify(eventDateFromFields({date:'2027-03-14',time:'02:30'})));`;
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        env: { ...process.env, TZ: "America/New_York" },
        encoding: "utf8",
      }
    );
    expect(JSON.parse(output)).toBeNull();
  });

  it("keeps a previously stored instant in a repeated DST hour when the time is unchanged", () => {
    const script = `import {eventDateFields,eventDateFromFields} from './client/src/lib/event-date.ts';
      const original = '2027-11-07T06:30:00.100Z';
      const fields = eventDateFields(original);
      console.log(JSON.stringify({fields, saved:eventDateFromFields({...fields, time:'01:30:00.1'}, original)}));`;
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          cwd: process.cwd(),
          env: { ...process.env, TZ: "America/New_York" },
          encoding: "utf8",
        }
      )
    );
    expect(result.fields).toEqual({ date: "2027-11-07", time: "01:30:00.100" });
    expect(result.saved).toBe("2027-11-07T06:30:00.100Z");
  });
});
