# Fontes locais

O layout e o mostruário de design usam `next/font/local`. Os arquivos WOFF2
acompanham o código e entram nas imagens pelo build normal. Nenhuma fonte é
baixada durante o build ou carregada do Google pelo navegador.

Origem: [google/fonts](https://github.com/google/fonts), revisão fixada em
`manifest.json`. Cada arquivo tem URL de origem, SHA-256 do TTF e do WOFF2,
eixos e quantidade de glifos. Cada família acompanha seu `*-OFL.txt` original.
A conversão TTF → WOFF2 usa fonttools 4.66.1 com brotli 1.2.0, sem subset,
alteração de eixos ou remoção de glifos; inclusive os caracteres de português.
As fontes variáveis conservam seus eixos; os pesos usados pela interface são
declarados nos módulos de `next/font/local`.

Não executar downloads em hooks de instalação ou no CI. Para atualizar uma
fonte, baixar de uma revisão explícita do repositório de origem, converter,
atualizar manifest/licença e revisar o resultado visual e o build. O manifest
é documentação e prova de integridade, não um instalador.

Motivo: o Next.js 16.3.3/Turbopack falha ao interpretar algumas URLs alternativas
retornadas pelo Google Fonts. [Bug upstream #99114](https://github.com/vercel/next.js/issues/99114).
