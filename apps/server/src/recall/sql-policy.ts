import { constants, type DatabaseSync } from 'node:sqlite';
import { RECALL_TABLE_COLUMNS } from './types.js';

const JSON_TABLES = new Set(['json_each', 'json_tree']);

const ALLOWED_FUNCTIONS = new Set(
  [
    'abs',
    'acos',
    'acosh',
    'asin',
    'asinh',
    'atan',
    'atan2',
    'atanh',
    'avg',
    'char',
    'coalesce',
    'concat',
    'concat_ws',
    'cos',
    'cosh',
    'count',
    'cume_dist',
    'date',
    'datetime',
    'degrees',
    'dense_rank',
    'exp',
    'first_value',
    'floor',
    'format',
    'glob',
    'group_concat',
    'hex',
    'if',
    'iif',
    'instr',
    'json',
    'json_array',
    'json_array_length',
    'json_error_position',
    'json_extract',
    'json_group_array',
    'json_group_object',
    'json_insert',
    'json_object',
    'json_patch',
    'json_pretty',
    'json_quote',
    'json_remove',
    'json_replace',
    'json_set',
    'json_type',
    'json_valid',
    'julianday',
    'lag',
    'last_value',
    'lead',
    'length',
    'like',
    'likelihood',
    'likely',
    'ln',
    'log',
    'log10',
    'log2',
    'lower',
    'ltrim',
    'max',
    'min',
    'mod',
    'nth_value',
    'ntile',
    'nullif',
    'octet_length',
    'percent_rank',
    'pi',
    'pow',
    'power',
    'printf',
    'quote',
    'radians',
    'rank',
    'replace',
    'round',
    'row_number',
    'rtrim',
    'sign',
    'sin',
    'sinh',
    'soundex',
    'sqrt',
    'strftime',
    'string_agg',
    'substr',
    'substring',
    'sum',
    'tan',
    'tanh',
    'time',
    'timediff',
    'total',
    'trim',
    'trunc',
    'typeof',
    'unhex',
    'unicode',
    'unixepoch',
    'unlikely',
    'upper',
  ].map((name) => name.toLowerCase()),
);

export function installRecallAuthorizer(database: DatabaseSync): () => boolean {
  let denied = false;
  database.setAuthorizer((action, arg1, arg2) => {
    if (action === constants.SQLITE_SELECT || action === constants.SQLITE_RECURSIVE) {
      return constants.SQLITE_OK;
    }
    if (action === constants.SQLITE_READ && arg1 !== null) {
      const table = arg1.toLowerCase();
      if (JSON_TABLES.has(table)) return constants.SQLITE_OK;
      const columns = RECALL_TABLE_COLUMNS[table as keyof typeof RECALL_TABLE_COLUMNS];
      if (
        columns &&
        arg2 !== null &&
        (arg2 === '' || (columns as readonly string[]).includes(arg2))
      ) {
        return constants.SQLITE_OK;
      }
    }
    if (
      action === constants.SQLITE_FUNCTION &&
      arg2 !== null &&
      ALLOWED_FUNCTIONS.has(arg2.toLowerCase())
    ) {
      return constants.SQLITE_OK;
    }
    denied = true;
    return constants.SQLITE_DENY;
  });
  return () => denied;
}
