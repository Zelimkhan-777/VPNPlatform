const label63 = 'a'.repeat(63);

export const vlessPublicConfigValidationMatrix = [
  { name: 'empty SNI', field: 'tlsServerName', value: '', accepted: false },
  {
    name: 'ordinary display name',
    field: 'displayName',
    value: 'Berlin route',
    accepted: true,
  },
  {
    name: '63-character label',
    field: 'tlsServerName',
    value: `${label63}.test`,
    accepted: true,
  },
  {
    name: '64-character label',
    field: 'tlsServerName',
    value: `${'a'.repeat(64)}.test`,
    accepted: false,
  },
  {
    name: '253-character hostname',
    field: 'tlsServerName',
    value: `${label63}.${label63}.${label63}.${'a'.repeat(61)}`,
    accepted: true,
  },
  {
    name: '254-character hostname',
    field: 'tlsServerName',
    value: `${label63}.${label63}.${label63}.${'a'.repeat(62)}`,
    accepted: false,
  },
  {
    name: 'leading hyphen',
    field: 'tlsServerName',
    value: '-bad.test',
    accepted: false,
  },
  {
    name: 'trailing hyphen',
    field: 'tlsServerName',
    value: 'bad-.test',
    accepted: false,
  },
  {
    name: 'consecutive dots',
    field: 'tlsServerName',
    value: 'bad..test',
    accepted: false,
  },
  {
    name: 'hyphen after separator',
    field: 'tlsServerName',
    value: 'a.-bad.test',
    accepted: false,
  },
  {
    name: 'mixed case hostname',
    field: 'tlsServerName',
    value: 'MiXeD.Example.TEST',
    accepted: true,
  },
  {
    name: 'Unicode hostname',
    field: 'tlsServerName',
    value: 'берлин.example',
    accepted: false,
  },
  {
    name: 'Unicode display name',
    field: 'displayName',
    value: 'Берлин route',
    accepted: true,
  },
  {
    name: 'carriage return',
    field: 'displayName',
    value: 'Berlin\rroute',
    accepted: false,
  },
  {
    name: 'line feed',
    field: 'displayName',
    value: 'Berlin\nroute',
    accepted: false,
  },
  {
    name: 'NUL',
    field: 'displayName',
    value: 'Berlin\0route',
    accepted: false,
  },
  {
    name: 'other control character',
    field: 'displayName',
    value: 'Berlin\u001froute',
    accepted: false,
  },
] as const;
