// Spoken airline name -> ICAO three letter prefix.
//
// Keys are what a controller actually says on frequency (the telephony
// callsign), plus the marketing name where it differs, because someone will
// type "Republic 4412" rather than "Brickyard 4412" and both must land on
// RPA4412.
//
// Keys are lowercase and may be multiple words. Lookup matches the LONGEST key
// first, so "sun country" beats a hypothetical "sun" and "korean air" beats
// "korean".

export const TELEPHONY: Record<string, string> = {
  // US mainline
  united: 'UAL',
  american: 'AAL',
  'american airlines': 'AAL',
  delta: 'DAL',
  southwest: 'SWA',
  alaska: 'ASA',
  'alaska air': 'ASA',
  'alaska airlines': 'ASA',
  jetblue: 'JBU',
  'jet blue': 'JBU',
  hawaiian: 'HAL',
  allegiant: 'AAY',
  'sun country': 'SCX',

  // US low cost. "Spirit Wings" is the telephony name, "Spirit" is the brand.
  'spirit wings': 'NKS',
  spirit: 'NKS',
  'frontier flight': 'FFT',
  frontier: 'FFT',
  moxy: 'MXY',
  breeze: 'MXY',
  avelo: 'VXP',

  // US regionals. These fly a large share of the SFO arrival stream and their
  // telephony names look nothing like the brand painted on the aircraft.
  skywest: 'SKW',
  'sky west': 'SKW',
  brickyard: 'RPA',
  republic: 'RPA',
  endeavor: 'EDV',
  'endeavor air': 'EDV',
  envoy: 'ENY',
  'air shuttle': 'ASH',
  mesa: 'ASH',
  'horizon air': 'QXE',
  horizon: 'QXE',
  cactus: 'AWI',
  'air wisconsin': 'AWI',

  // Europe
  speedbird: 'BAW',
  'british airways': 'BAW',
  british: 'BAW',
  lufthansa: 'DLH',
  airfrans: 'AFR',
  'air france': 'AFR',
  klm: 'KLM',
  'klm royal dutch': 'KLM',
  swiss: 'SWR',
  shamrock: 'EIN',
  'aer lingus': 'EIN',
  virgin: 'VIR',
  'virgin atlantic': 'VIR',
  iberia: 'IBE',
  scandinavian: 'SAS',
  iceair: 'ICE',
  icelandair: 'ICE',
  turkish: 'THY',

  // Middle East and Asia Pacific
  emirates: 'UAE',
  qatari: 'QTR',
  qatar: 'QTR',
  etihad: 'ETD',
  singapore: 'SIA',
  cathay: 'CPA',
  'cathay pacific': 'CPA',
  dynasty: 'CAL',
  'china airlines': 'CAL',
  eva: 'EVA',
  'eva air': 'EVA',
  'korean air': 'KAL',
  korean: 'KAL',
  asiana: 'AAR',
  'all nippon': 'ANA',
  ana: 'ANA',
  'japan air': 'JAL',
  'japan airlines': 'JAL',
  qantas: 'QFA',
  'air new zealand': 'ANZ',
  'china eastern': 'CES',
  'china southern': 'CSN',
  'air china': 'CCA',
  philippine: 'PAL',

  // Americas
  'air canada': 'ACA',
  'air canada rouge': 'ROU',
  copa: 'CMP',
  aeromexico: 'AMX',
  volaris: 'VOI',
  latam: 'LAN',

  // Cargo
  fedex: 'FDX',
  ups: 'UPS',
  giant: 'GTI',
  atlas: 'GTI',
  'polar tiger': 'PAC',
  'cargo king': 'CKS',
}

/**
 * Telephony keys sorted longest first, so a greedy scan matches "korean air"
 * before it can match "korean".
 */
export const TELEPHONY_KEYS_BY_LENGTH: string[] = Object.keys(TELEPHONY).sort(
  (a, b) => b.split(' ').length - a.split(' ').length || b.length - a.length,
)

/** Every ICAO prefix in the table, for validating a directly typed callsign. */
export const KNOWN_ICAO_PREFIXES: ReadonlySet<string> = new Set(Object.values(TELEPHONY))
