import localFont from "next/font/local";

// Arquivos versionados: o build não depende da resposta variável do Google Fonts.
// Constantes no módulo são exigidas por next/font; o seletor mantém as variáveis CSS.

export const bricolage = localFont({
  src: "../../fonts/bricolage-grotesque.woff2",
  weight: "200 800",
  style: "normal",
  display: "swap",
  variable: "--font-bricolage",
});

export const jakarta = localFont({
  src: "../../fonts/plus-jakarta-sans.woff2",
  weight: "200 800",
  style: "normal",
  display: "swap",
  variable: "--font-jakarta",
});

export const fraunces = localFont({
  src: "../../fonts/fraunces.woff2",
  weight: "100 900",
  style: "normal",
  adjustFontFallback: "Times New Roman",
  display: "swap",
  variable: "--font-fraunces",
});

export const manrope = localFont({
  src: "../../fonts/manrope.woff2",
  weight: "200 800",
  style: "normal",
  display: "swap",
  variable: "--font-manrope",
});

export const atkinson = localFont({
  src: [
    { path: "../../fonts/atkinson-regular.woff2", weight: "400", style: "normal" },
    { path: "../../fonts/atkinson-bold.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  variable: "--font-atkinson",
});

export const sourceSerif = localFont({
  src: "../../fonts/source-serif-4.woff2",
  weight: "200 900",
  style: "normal",
  adjustFontFallback: "Times New Roman",
  display: "swap",
  variable: "--font-source-serif",
});

export const plexSans = localFont({
  src: "../../fonts/ibm-plex-sans.woff2",
  weight: "300 700",
  style: "normal",
  display: "swap",
  variable: "--font-plex-sans",
});

export const plexMono = localFont({
  src: [
    { path: "../../fonts/ibm-plex-mono-regular.woff2", weight: "400", style: "normal" },
    { path: "../../fonts/ibm-plex-mono-medium.woff2", weight: "500", style: "normal" },
  ],
  display: "swap",
  variable: "--font-plex-mono",
});

export const jetbrains = localFont({
  src: "../../fonts/jetbrains-mono.woff2",
  weight: "100 800",
  style: "normal",
  display: "swap",
  variable: "--font-jetbrains",
});

export const allFontVariables = [
  bricolage.variable,
  jakarta.variable,
  fraunces.variable,
  manrope.variable,
  atkinson.variable,
  sourceSerif.variable,
  plexSans.variable,
  plexMono.variable,
  jetbrains.variable,
].join(" ");
