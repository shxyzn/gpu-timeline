import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarDay} from '../dist/calendar.js';

test('holidays follow Korean midnight regardless of the viewer timezone', () => {
  assert.equal(calendarDay('2026-10-08T14:59:59Z').holiday, null);
  assert.equal(calendarDay('2026-10-08T15:00:00Z').holiday, '한글날');
  assert.equal(calendarDay('2026-10-08T15:00:00Z').weekday, '금');
  assert.equal(calendarDay('2026-10-09T15:00:00Z').holiday, null);
});

test('lunar dates, specific substitute days, election and new holidays are included', () => {
  for (const [date, name] of [
    ['2026-10-03', '개천절'], ['2026-10-05', '대체공휴일 · 개천절'],
    ['2026-02-17', '설날'], ['2026-05-25', '대체공휴일 · 부처님오신날'],
    ['2026-06-03', '전국동시지방선거'], ['2026-05-01', '노동절'], ['2026-07-17', '제헌절'],
    ['2027-02-09', '대체공휴일 · 설날'], ['2027-05-13', '부처님오신날'],
    ['2027-07-19', '대체공휴일 · 제헌절'], ['2027-12-27', '대체공휴일 · 성탄절'],
  ]) assert.equal(calendarDay(`${date}T12:00:00+09:00`).holiday, name);
  for (const date of ['2026-06-08', '2026-09-28', '2027-06-07']) {
    assert.equal(calendarDay(`${date}T12:00:00+09:00`).holiday, null);
  }
});

test('year boundaries distinguish a known ordinary day from missing holiday data', () => {
  assert.equal(calendarDay('2026-12-31T15:00:00Z').holiday, '신정');
  assert.equal(calendarDay('2027-01-04T00:00:00+09:00').covered, true);
  assert.equal(calendarDay('2027-12-31T15:00:00Z').covered, false);
  assert.equal(calendarDay('2025-12-31T00:00:00+09:00').covered, false);
  assert.equal(calendarDay('invalid'), null);
});
