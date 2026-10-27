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
    const deliveryDenial = /\bnao\s+(?:(?:vou|posso|consigo|podemos|vamos|foi possivel|e possivel|sera possivel|tenho como|da para)\s+)?(?:te\s+|lhe\s+)?(?:repet\w*|reenvi\w*|envi\w*|mand\w*|anex\w*|encaminh\w*)\b/.test(s);
    const denial = deliveryDenial && (target || !namesFormat && /\b(?:enviar|reenviar|repetir|mandar|anexar|encaminhar)(?:\s+(?:agora|aqui|isso|novamente|mais))?\s*[.!?]?$/.test(s));
    const agentContinuation = /\b(?:posso|consigo|vou|vamos|podemos|sigo|seguimos|seguirei|continuo|continuamos|respondo|responderei|explico|explicarei|nesta resposta|nessa resposta)\b/.test(s);
    const textOnly = (agentContinuation || /^\s*(?:apenas|somente|so)\b/.test(s))
      && /\b(?:apenas|somente|so)\s+(?:por\s+|em\s+)?texto\b|\b(?:por\s+|em\s+)texto[^.!?]{0,30}\bsem\s+repet\w*/.test(s);
    const previousDelivery = target && /\b(?:ja\s+(?:foi\s+)?(?:enviad\w*|mandad\w*|encaminhad\w*)|ja\s+(?:te\s+|lhe\s+)?(?:enviei|mandei|encaminhei))\b/.test(s);
    const recordingClaim = /\b(?:estou|to)\s+gravando\b/.test(s);
    const withoutTarget = kind && formats[kind].test(s) && agentContinuation
      && /\bsem\s+(?:(?:o|a|esse|essa|este|esta|um|uma)\s+)?(?:audio|imagem|foto|video)\b/.test(s);
    const bad = denial || textOnly || previousDelivery || recordingClaim || withoutTarget;
    if (bad) amended = true;
    return !bad;
  }).join(' ')).filter(part => part.trim()).join('\n\n').trim();
  return { body: amended ? coherent || NEUTRAL_CONTEXT : body, amended };
}

/** Mídia opcional pode não sair. Sem conteúdo restante, não enviar só uma
 * introdução vazia: o Conversador pode corrigir pela própria fila de ferramentas. */
export function optionalMediaContextVeto(context: ReturnType<typeof coherentMediaContext>, required: boolean) {
  return !required && context.amended && context.body === NEUTRAL_CONTEXT ? {
    ok: false as const,
    error: { code: 'media_context_incompatible', message: 'A mídia é opcional e ainda não foi enviada. Escreva um contexto útil se for usar o arquivo, ou uma resposta completa por texto. Não negue o envio para depois anexar a mesma mídia.' },
  } : null;
}
