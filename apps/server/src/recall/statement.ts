import { RecallError } from './types.js';

export function assertSingleRecallStatement(sql: string): void {
  let statementEnded = false;
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];
    if (character === '-' && next === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      index = quotedEnd(sql, index, character, character + character);
      continue;
    }
    if (character === '[') {
      index = quotedEnd(sql, index, ']', ']]');
      continue;
    }
    if (character === ';') {
      statementEnded = true;
      index += 1;
      continue;
    }
    if (statementEnded && character !== undefined && !/\s/.test(character)) {
      throw new RecallError('invalid_query', 'SQL recall accepts exactly one statement.');
    }
    index += 1;
  }
}

function quotedEnd(sql: string, start: number, delimiter: string, escaped: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql.startsWith(escaped, index)) {
      index += escaped.length;
      continue;
    }
    if (sql[index] === delimiter) return index + 1;
    index += 1;
  }
  return sql.length;
}
