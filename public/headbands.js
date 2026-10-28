// Standaardlijst kapitaalbanden: Kopfband art. 55 608 (12,5 mm), kleurnummers van de kleurkaart
// van Menge; de kleuren zijn van foto's overgenomen en dus bij benadering. De beheerder kan de lijst
// op de beheerpagina aanpassen; die lijst staat dan op de server.
export const DEFAULT_HEADBANDS = [
  { code: '100', name: 'Wit', colors: ['#f4f1e6'] },
  { code: '000', name: 'Naturel wit', colors: ['#efeadc'] },
  { code: '906', name: 'Gebroken wit', colors: ['#e2ded5'] },
  { code: '408', name: 'Lichtgrijs', colors: ['#b7bcc0'] },
  { code: '396', name: 'Grijs', colors: ['#6e7178'] },
  { code: '999', name: 'Zwart', colors: ['#161616'] },
  { code: '704', name: 'Champagne', colors: ['#d8c79e'] },
  { code: '725', name: 'Goud brons', colors: ['#a08350'] },
  { code: '866', name: 'Bruin', colors: ['#5a3424'] },
  { code: '412', name: 'Donkerbruin', colors: ['#3a2420'] },
  { code: '406', name: 'Geel', colors: ['#f0d22a'] },
  { code: '441', name: 'Okergeel', colors: ['#d6bd35'] },
  { code: '220', name: 'Neongeel', colors: ['#eef03a'] },
  { code: '614', name: 'Limoen', colors: ['#c8d84a'] },
  { code: '348', name: 'Oranje', colors: ['#f07a28'] },
  { code: '369', name: 'Rood', colors: ['#d6202a'] },
  { code: '489', name: 'Donkerrood', colors: ['#a81d36'] },
  { code: '382', name: 'Bordeaux', colors: ['#7a1a22'] },
  { code: '555', name: 'Paars', colors: ['#5b2a8a'] },
  { code: '560', name: 'Lichtblauw', colors: ['#3f7fc4'] },
  { code: '537', name: 'Helderblauw', colors: ['#1f8fe0'] },
  { code: '573', name: 'Koningsblauw', colors: ['#1d3f9a'] },
  { code: '325', name: 'Marineblauw', colors: ['#1d2a6b'] },
  { code: '683', name: 'Petrol', colors: ['#126b72'] },
  { code: '684', name: 'Turquoise', colors: ['#0f8395'] },
  { code: '644', name: 'Groen', colors: ['#1f8a55'] },
  { code: '618', name: 'Lichtgroen', colors: ['#6cc23a'] },
  { code: '660', name: 'Donkergroen', colors: ['#1d5a32'] },
  { code: '427', name: 'Flessengroen', colors: ['#1f3a2c'] },
  { code: '059', name: 'Rood/zwart gestreept', colors: ['#c8232b', '#161616'] },
  { code: '013', name: 'Rood/groen gestreept', colors: ['#c0392b', '#5f9e48'] },
  { code: '001', name: 'Petrol/wit gestreept', colors: ['#1e7f86', '#f4f1e8'] },
  { code: '01A', name: 'Groen/wit gestreept', colors: ['#1f9a5a', '#f4f1e8'] },
  { code: '002', name: 'Blauw/wit gestreept', colors: ['#3a78c2', '#f4f1e8'] },
  { code: '02A', name: 'Marine/wit gestreept', colors: ['#1e2f78', '#f4f1e8'] },
  { code: '004', name: 'Paars/wit gestreept', colors: ['#6a3fa0', '#f4f1e8'] },
  { code: '005', name: 'Rood/wit gestreept', colors: ['#d33a3a', '#f4f1e8'] },
  { code: '017', name: 'Zwart/wit gestreept', colors: ['#1a1a1a', '#f4f1e8'] },
  { code: '012', name: 'Oranjerood/wit gestreept', colors: ['#e5462a', '#f4f1e8'] },
  { code: '518', name: 'Goud/wit gestreept', colors: ['#b99a55', '#f4f1e8'] },
  { code: '209', name: 'Bordeaux/goud gestreept', colors: ['#6b1f24', '#c9a24a'] },
  { code: '158', name: 'Groen/goud gestreept', colors: ['#2e9a4a', '#c9a24a'] },
  { code: '049', name: 'Zwart/goud gestreept', colors: ['#1a1a1a', '#c9a24a'] },
];

// Het kapitaalband van een boek (ook voor oudere boeken met alleen een kleur).
export function headbandOf(meta) {
  if (meta.headband && meta.headband.colors?.length) return meta.headband;
  if (meta.headbandColor) return { code: '', name: '', colors: [meta.headbandColor] };
  return DEFAULT_HEADBANDS[0];
}

// Een opgeslagen lijst zonder enige code is de oude standaardlijst: dan de nieuwe gebruiken.
export const usableHeadbands = (stored) => (Array.isArray(stored) && stored.some((h) => h.code) ? stored : DEFAULT_HEADBANDS);

export const headbandLabel = (h) => [h.name, h.code].filter(Boolean).join(' ') || h.colors.join('/');
