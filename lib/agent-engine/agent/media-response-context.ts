import { normalizeMediaText } from './media-intent';

const NEUTRAL_CONTEXT = 'Sobre esse assunto:';

/** Contenção local, sem outro LLM. Só se aplica a uma mídia atualmente autorizada. */
export function coherentMediaContext(body: string, kind?: 'audio' | 'image' | 'video'): { body: string; amended: boolean } {
  let amended = false;
  const coherent = body.split(/\n\s*\n/).map(paragraph => paragraph.split(/(?<=[.!?])\s+/).filter(sentence => {
    const s = normalizeMediaText(sentence);
    const formats = { audio: /\b(?:audios?|voice)\b/, image: /\b(?:foto|imagen|imagens|imagem|image)s?\b/, video: /\bvideos?\b/ };
    const namesFormat = Object.values(formats).some(pattern => pattern.test(s));
    const target = !kind || formats[kind].test(s) || /\b(?:arquivo|midia|apresentacao|gravacao|file|media)s?\b/.test(s);
    // Negar outro formato não contradiz o arquivo escolhido. A negativa sem
    // objeto (“não consigo enviar agora”) continua sendo uma negativa de envio.
    const deliveryDenial = /\bnao\s+(?:(?:vou|posso|consigo|podemos|vamos|foi possivel|e possivel|sera possivel)\s+)?(?:te\s+|lhe\s+)?(?:repet\w*|reenvi\w*|envi\w*|mand\w*|anex\w*|encaminh\w*)\b/.test(s);
    const denial = deliveryDenial && (target || !namesFormat && /\b(?:enviar|reenviar|repetir|mandar|anexar|encaminhar)(?:\s+(?:agora|aqui|isso|novamente|mais))?\s*[.!?]?$/.test(s));
    const textOnly = /\b(?:apenas|somente|so)\s+(?:por\s+|em\s+)?texto\b|\b(?:por\s+|em\s+)texto[^.!?]{0,30}\bsem\s+repet\w*/.test(s);
    const previousDelivery = target && /\b(?:ja\s+(?:foi\s+)?(?:enviad\w*|mandad\w*|encaminhad\w*)|ja\s+(?:te\s+|lhe\s+)?(?:enviei|mandei|encaminhei))\b/.test(s);
    const recordingClaim = /\b(?:estou|to)\s+gravando\b/.test(s);
    const withoutTarget = kind && formats[kind].test(s) && /\bsem\s+(?:(?:o|a|esse|essa|este|esta|um|uma)\s+)?(?:audio|imagem|foto|video)\b/.test(s);
    const bad = denial || textOnly || previousDelivery || recordingClaim || withoutTarget;
    if (bad) amended = true;
    return !bad;
  }).join(' ')).filter(part => part.trim()).join('\n\n').trim();
  return { body: amended ? coherent || NEUTRAL_CONTEXT : body, amended };
}
