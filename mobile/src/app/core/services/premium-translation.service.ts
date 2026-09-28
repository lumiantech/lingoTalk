import { Injectable } from '@angular/core';

import {
  environment
} from '../../../environments/environment';


export interface PremiumTranslationContextMessage {
  originalText: string;
  translatedText: string;
}


export interface PremiumTranslationRequest {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  context: PremiumTranslationContextMessage[];
}


export interface PremiumTranslationResult {
  correctedOriginalText: string;
  translatedText: string;
}


@Injectable({
  providedIn: 'root'
})
export class PremiumTranslationService {

  async translate(
    text: string,
    sourceLanguage: string,
    targetLanguage: string,
    context:
      PremiumTranslationContextMessage[]
  ): Promise<PremiumTranslationResult> {

    const cleanText =
      text.trim();

    if (!cleanText) {
      throw new Error(
        'Cannot translate empty text.'
      );
    }

    const response =
      await fetch(
        `${environment.apiBaseUrl}/api/translation/premium`,
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json'
          },

          body: JSON.stringify({
            text: cleanText,
            sourceLanguage,
            targetLanguage,

            /*
             * Defense in depth:
             * never send more than the last
             * three completed subtitle messages.
             */
            context:
              context.slice(-3)
          } satisfies PremiumTranslationRequest)
        }
      );

    if (!response.ok) {

      const body =
        await response.text();

      throw new Error(
        `Premium translation failed ` +
        `(${response.status}): ${body}`
      );
    }

    const result = await response.json() as PremiumTranslationResult;

    if (
      !result.correctedOriginalText?.trim() ||
      !result.translatedText?.trim()
    ) {
      throw new Error(
        'Premium translation returned an invalid result.'
      );
    }

    return {
      correctedOriginalText:
        result.correctedOriginalText.trim(),

      translatedText:
        result.translatedText.trim()
    };
  }
}
