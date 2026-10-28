// Standaardlijst kapitaalbanden. De beheerder kan deze lijst op de beheerpagina aanpassen
// (codes en kleuren van de eigen leverancier); die lijst staat dan op de server.
export const DEFAULT_HEADBANDS = [
  { code: '', name: 'Wit', colors: ['#ffffff'] },
  { code: '', name: 'Crème', colors: ['#efe6cf'] },
  { code: '', name: 'Zwart', colors: ['#1b1b1b'] },
  { code: '', name: 'Grijs', colors: ['#9a9ea3'] },
  { code: '', name: 'Goud', colors: ['#c9a24a'] },
  { code: '', name: 'Zilver', colors: ['#c7cbd0'] },
  { code: '', name: 'Rood', colors: ['#b3202a'] },
  { code: '', name: 'Bordeaux', colors: ['#6e1a2a'] },
  { code: '', name: 'Donkerblauw', colors: ['#1f2f5c'] },
  { code: '', name: 'Lichtblauw', colors: ['#8fb4d9'] },
  { code: '', name: 'Groen', colors: ['#2e6b45'] },
  { code: '', name: 'Geel', colors: ['#e9c440'] },
  { code: '', name: 'Oranje', colors: ['#e07b2a'] },
  { code: '', name: 'Roze', colors: ['#e7a1b5'] },
  { code: '', name: 'Bruin', colors: ['#6b4a32'] },
  { code: '', name: 'Wit/zwart', colors: ['#ffffff', '#1b1b1b'] },
  { code: '', name: 'Rood/wit', colors: ['#b3202a', '#ffffff'] },
  { code: '', name: 'Blauw/wit', colors: ['#1f2f5c', '#ffffff'] },
  { code: '', name: 'Groen/wit', colors: ['#2e6b45', '#ffffff'] },
  { code: '', name: 'Goud/zwart', colors: ['#c9a24a', '#1b1b1b'] },
  { code: '', name: 'Rood/zwart', colors: ['#b3202a', '#1b1b1b'] },
  { code: '', name: 'Wit/goud', colors: ['#ffffff', '#c9a24a'] },
];

// Het kapitaalband van een boek (ook voor oudere boeken met alleen een kleur).
export function headbandOf(meta) {
  if (meta.headband && meta.headband.colors?.length) return meta.headband;
  if (meta.headbandColor) return { code: '', name: '', colors: [meta.headbandColor] };
  return DEFAULT_HEADBANDS[0];
}

export const headbandLabel = (h) => [h.name, h.code].filter(Boolean).join(' ') || h.colors.join('/');
