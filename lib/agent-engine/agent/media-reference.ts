import { mediaKind, type ApprovedMedia } from '@/lib/ai/agents/approved-media';
import { explicitMediaPreference } from './media-preference';
import { mediaPreferenceClauses } from './media-preference-scope';
import { clearRepeatIntent, normalizeMediaText, NO_MEDIA_INTENT, type MediaIntent } from './media-intent';

export interface ExplicitMediaReference {
  intent: MediaIntent;
  reason?: 'ambiguous_media_reference';
  source: 'explicit_reference' | 'text_preference';
}

const words = (text: string) => normalizeMediaText(text).match(/[\p{L}\p{N}]+/gu) ?? [];

/** Só identifica referência unívoca no catálogo. A autorização continua no servidor. */
export function resolveExplicitMediaReference(subject: string, catalog: ApprovedMedia[]): ExplicitMediaReference | null {
  // Dois-pontos também introduzem o pedido: “prefiro ouvir: reenvia o áudio X”.
  // A normalização é só de seleção; não grava uma preferência durável nova.
  const selectionText = subject.replace(/:/g, ',');
  const kinds = ['audio', 'image', 'video'] as const;
  if (kinds.every(kind => explicitMediaPreference(selectionText, kind) === 'text'))
    return { intent: { ...NO_MEDIA_INTENT, text_only: true }, source: 'text_preference' };
  const requested = kinds.filter(kind => explicitMediaPreference(selectionText, kind) === 'audio');
  if (requested.length !== 1) return null;
  const kind = requested[0]!;
  // A correção posterior substitui a oração anterior. Formatos negados não são títulos.
  const clause = mediaPreferenceClauses(selectionText).filter(part => explicitMediaPreference(part, kind) === 'audio').at(-1);
  if (!clause) return null;
  const request = ` ${words(clause.split(/,\s*(?:sem|sin|não|nao|no)\b/iu)[0]!).join(' ')} `;
  const scored = catalog.filter(item => item.enabled && mediaKind(item) === kind).map(item => {
    const title = words(item.title);
    let score = 0;
    let span: [number, number] = [0, 0];
    for (let length = 1; length <= title.length; length++) {
        const part = title.slice(0, length);
        const phrase = ` ${part.join(' ')} `;
        const offset = request.indexOf(phrase);
        // Um prefixo abreviado só vale no fim do pedido. “Como funciona o
        // pagamento” não referencia “Como funciona o aplicativo”.
        const remainder = offset < 0 ? null : request.slice(offset + phrase.length).trim();
        const complete = length === title.length || remainder !== null
          && /^(?:(?:por favor|para mim|pra mim|obrigado|obrigada)\s*)*$/.test(remainder);
        if ((length >= 2 || title.length === 1 && part[0]!.length >= 6)
          && part.some(word => word.length >= 4)
          && offset >= 0 && complete && length > score) {
          score = length;
          span = [offset, offset + phrase.length];
        }
      }
    return { item, score, span };
  }).filter(match => match.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  const best = scored[0]!;
  if (scored.slice(1).some(match => match.score === best.score
    || match.span[0] < best.span[0] || match.span[1] > best.span[1]))
    return { intent: { ...NO_MEDIA_INTENT }, reason: 'ambiguous_media_reference', source: 'explicit_reference' };
  return { source: 'explicit_reference', intent: { audio_id: best.item.id,
    intent: clearRepeatIntent(clause) ? 'repeat' : 'show', format: kind, text_only: false } };
}
