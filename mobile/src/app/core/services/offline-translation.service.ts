import { Injectable } from '@angular/core';

import {
    Capacitor,
    registerPlugin
} from '@capacitor/core';

export interface TranslationResult {
    originalText: string;
    translatedText: string;
    sourceLanguage: string;
    targetLanguage: string;
}

interface OfflineTranslationNativePlugin {

    translate(options: {
        text: string;
        sourceLanguage: string;
        targetLanguage: string;
    }): Promise<TranslationResult>;
}

const OfflineTranslation =
    registerPlugin<OfflineTranslationNativePlugin>(
        'OfflineTranslation'
    );

@Injectable({
    providedIn: 'root'
})
export class OfflineTranslationService {

    async translate(
        text: string,
        sourceLanguage: string,
        targetLanguage: string
    ): Promise<TranslationResult> {

        const cleanText = text.trim();

        if (!cleanText) {
            throw new Error(
                'Cannot translate empty text.'
            );
        }

        /*
         * Google ML Kit koji sada dodajemo
         * postoji samo u Android native aplikaciji.
         */
        if (
            !Capacitor.isNativePlatform() ||
            Capacitor.getPlatform() !== 'android'
        ) {
            throw new Error(
                'Offline ML Kit translation is available only on Android.'
            );
        }

        return OfflineTranslation.translate({
            text: cleanText,
            sourceLanguage,
            targetLanguage
        });
    }
}