
import { CommonModule } from '@angular/common';
import {
  Component,
  effect,
  ElementRef,
  inject,
  OnDestroy,
  signal,
  ViewChild
} from '@angular/core';

import { FormsModule } from '@angular/forms';

import {
  IonButton,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar
} from '@ionic/angular';

import { Capacitor } from '@capacitor/core';



import {
  OfflineTranslationService
} from '../../../core/services/offline-translation.service';


import {
  environment
} from '../../../../environments/environment';

import {
  WebRtcService
} from '../../../core/services/web-rtc.service';

import { SpeechRecognitionService } from '../../../core/services/speech-recognition.service';
import { SubtitleMessage, TranslationSignalRService } from '../../../core/services/translation-signal-r';

interface ConversationMessage {
  text: string;
  direction: 'sent' | 'received';
}


@Component({
  selector: 'app-conversation',
  standalone: true,
  templateUrl:
    './conversation.page.component.html',
  styleUrls: [
    './conversation.page.component.scss'
  ],
  imports: [
    CommonModule,
    FormsModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonItem,
    IonLabel,
    IonInput,
    IonButton,
    IonList,
    IonSelect,
    IonSelectOption
  ]
})
export class ConversationPageComponent
  implements OnDestroy {

  @ViewChild('localVideo')
  private localVideo?:
    ElementRef<HTMLVideoElement>;

  @ViewChild('remoteVideo')
  private remoteVideo?:
    ElementRef<HTMLVideoElement>;


  private readonly signalR =
    inject(TranslationSignalRService);

  private readonly offlineTranslation =
    inject(OfflineTranslationService);


  /*
   * Translation engine.
   *
   * Default is PREMIUM for the current test.
   * Later the UI/account AccessTier can set
   * this to 'free' or 'premium'.
   */
  translationMode: 'free' | 'premium' =
    (
      localStorage.getItem(
        'lingo-translation-mode'
      ) === 'free'
    )
      ? 'free'
      : 'premium';

  readonly webRtc =
    inject(WebRtcService);

  readonly speech =
    inject(SpeechRecognitionService);


  readonly languages = [
    { code: 'en-US', name: 'English' },
    { code: 'de-DE', name: 'Deutsch' },
    { code: 'es-ES', name: 'Español' },
    { code: 'fr-FR', name: 'Français' },
    { code: 'it-IT', name: 'Italiano' },
    { code: 'pt-PT', name: 'Português' },
    { code: 'ar-AR', name: 'العربية' },
    { code: 'ru-RU', name: 'Русский' },
    { code: 'hr-HR', name: 'Hrvatski' }
  ];


  selectedLanguage =
    localStorage.getItem(
      'lingo-language'
    ) ?? 'hr-HR';

  sessionId = '';

  messageText = '';


  connected = signal(false);

  joined = signal(false);

  remoteLanguage =
    signal<string | null>(null);

  subtitle =
    signal<SubtitleMessage | null>(null);

  /*
   * LIVE subtitle pipeline:
   * - liveSttText: newest Sherpa hypothesis for the current 1-5 word chunk
   * - liveLocalTranslation: ML Kit translation of that exact hypothesis
   * - liveAiOriginal/liveAiTranslation: OpenAI result for the last committed chunk
   *
   * ML Kit is allowed to revise continuously as Sherpa revises its partial.
   * OpenAI runs only when a chunk is committed (5 words or pause/final).
   */
  readonly liveSttText = signal('');
  readonly liveLocalTranslation = signal('');
  readonly liveAiOriginal = signal('');
  readonly liveAiTranslation = signal('');
  readonly liveAiPending = signal(false);

  messages =
    signal<ConversationMessage[]>([]);


  /*
   * Subtitle transcript/history.
   *
   * This is intentionally separate from
   * manual text chat.
   */
  readonly localHistory = signal<SubtitleMessage[]>([]);
  readonly aiHistory = signal<SubtitleMessage[]>([]);
  readonly historyOpen = signal(false);
  readonly activeHistory = signal<'local' | 'ai'>('local');

  private latestDisplayedSegmentId = '';

  // Call UI state. Audio/video track control stays inside WebRtcService.
  readonly microphoneEnabled = signal(true);
  readonly cameraEnabled = signal(true);
  readonly subtitlesVisible = signal(true);

  readonly colorTheme = signal<'azure' | 'indigo'>(
    localStorage.getItem('lingo-color-theme') === 'indigo'
      ? 'indigo'
      : 'azure'
  );


  /*
   * Sherpa stream/chunk state.
   */
  private segmentCounter = 0;

  /*
   * Native Sherpa owns utterance boundaries.
   * Angular never guesses an endpoint from elapsed time.
   */
  private currentUtteranceId = 0;
  private lastHandledFinalUtteranceId = 0;

  /*
   * Each new Sherpa partial invalidates older ML Kit requests.
   * If "Where" finishes translating after "Where are", the old
   * result must never overwrite the newer one.
   */
  private liveTranslationRevision = 0;

  // Text that liveLocalTranslation currently belongs to.
  private liveLocalSourceText = '';

  /*
   * Prevent the same committed text from starting OpenAI twice.
   */
  private lastCommittedChunk = '';


  /*
   * FINAL subtitle segmentation only.
   * Active Sherpa partials are never consumed/split.
   */
  private readonly maxChunkWords = 5;
  private readonly maxChunkChars = 30;

  private translationTimer:
    ReturnType<typeof setTimeout> | undefined;



  constructor() {

    /*
     * WebRTC connection controls STT.
     */
    effect(() => {

      const callConnected =
        this.webRtc.callConnected();

      console.log(
        '★★★★★ CALL CONNECTED:',
        callConnected,
        '★★★★★'
      );

      if (callConnected) {

        console.log(
          '★★★★★ STARTING STT',
          this.selectedLanguage,
          '★★★★★'
        );

        void this.speech.start(
          this.selectedLanguage
        );

      } else {

        console.log(
          '★★★★★ STOPPING STT ★★★★★'
        );

        void this.speech.stop();
      }
    });


    /*
     * Sherpa partial is a mutable hypothesis for ONE native utterance.
     * Always display/translate the complete current hypothesis.
     * Never mark words as consumed while Sherpa is still speaking.
     */
    effect(() => {
      const utteranceId = this.speech.partialUtteranceId();
      const partial = this.speech.partialText().trim();

      if (!partial) return;

      this.currentUtteranceId = utteranceId;

      this.translationLog('STT_PARTIAL', {
        utteranceId,
        text: partial,
        words: this.splitWords(partial).length
      });

      this.processPartial(partial, utteranceId);
    });


    /*
     * Only native Sherpa FINAL closes the utterance.
     * finalUtteranceId makes identical consecutive phrases observable too.
     */
    effect(() => {
      const utteranceId = this.speech.finalUtteranceId();
      const finalText = this.speech.finalText().trim();

      if (!finalText || utteranceId <= 0) return;
      if (utteranceId === this.lastHandledFinalUtteranceId) return;

      this.lastHandledFinalUtteranceId = utteranceId;

      this.translationLog('STT_FINAL', {
        utteranceId,
        text: finalText,
        words: this.splitWords(finalText).length
      });

      void this.flushFinalText(finalText, utteranceId);
    });
  }


  async languageChanged():
    Promise<void> {

    localStorage.setItem(
      'lingo-language',
      this.selectedLanguage
    );

    /*
     * A language change starts a clean
     * speech/chunk stream.
     */
    this.resetSherpaSegment();

    this.lastHandledFinalUtteranceId = 0;

    if (this.joined()) {

      await this.signalR.updateLanguage(
        this.sessionId.trim(),
        this.selectedLanguage
      );
    }

    if (this.webRtc.callConnected()) {

      await this.speech.restart(
        this.selectedLanguage
      );
    }
  }


  async connect():
    Promise<void> {

    await this.signalR.connect(
      environment.apiBaseUrl
    );


    this.signalR
      .onParticipantLanguageChanged(
        language => {

          console.log(
            '★★★★★ REMOTE LANGUAGE:',
            language,
            '★★★★★'
          );

          this.remoteLanguage.set(
            language
          );
        }
      );


    this.signalR
      .onParticipantLeft(
        () => {

          this.remoteLanguage.set(
            null
          );
        }
      );


    /*
     * Subtitle produced by the other
     * participant.
     *
     * Display it and put exactly the same
     * pair into local subtitle history.
     */
    this.signalR
      .onSubtitleReceived(
        subtitle => {
          // LOCAL from the other participant arrives immediately.
          this.subtitle.set(subtitle);
          this.latestDisplayedSegmentId = subtitle.segmentId;
          this.liveSttText.set(subtitle.originalText);
          this.liveLocalTranslation.set(subtitle.translatedText);
          this.liveLocalSourceText = subtitle.originalText.trim();
          this.liveAiOriginal.set('');
          this.liveAiTranslation.set('');
          this.liveAiPending.set(subtitle.requestAi);
          this.addLocalHistory(subtitle);
        }
      );

    this.signalR
      .onAiSubtitleReceived(
        subtitle => {
          // AI is broadcast by backend to BOTH sender and receiver.
          this.addAiHistory(subtitle);

          // An older OpenAI request may finish after a newer segment.
          // Never let it overwrite the newest live subtitle card.
          if (subtitle.segmentId !== this.latestDisplayedSegmentId) {
            return;
          }

          this.liveAiOriginal.set(subtitle.originalText);
          this.liveAiTranslation.set(subtitle.translatedText);
          this.liveAiPending.set(false);
        }
      );


    /*
     * Existing manual text chat.
     */
    this.signalR.onTextReceived(
      (text: string) => {

        this.messages.update(
          messages => [
            ...messages,
            {
              text,
              direction: 'received'
            }
          ]
        );
      }
    );


    this.registerWebRtcSignaling();

    this.connected.set(
      true
    );
  }


  async joinSession():
    Promise<void> {

    const sessionId =
      this.sessionId.trim();

    if (!sessionId) {
      return;
    }

    if (!this.connected()) {

      await this.connect();
    }

    await this.signalR.joinSession(
      sessionId,
      this.selectedLanguage
    );

    this.joined.set(
      true
    );
  }


  /*
   * =========================================================
   * SUBTITLE CHUNKING
   * =========================================================
   */


  private processPartial(
    fullText: string,
    utteranceId: number
  ): void {

    if (!this.joined() || !this.remoteLanguage()) return;

    /*
     * A partial is the COMPLETE mutable hypothesis for this utterance.
     * Example:
     *   need to
     *   need to fix
     *   need to fix this
     *
     * Do not slice off words and do not start a pause timer here.
     */
    this.currentUtteranceId = utteranceId;
    this.showLiveChunk(fullText);
  }


  private showLiveChunk(
    text: string
  ): void {

    const cleanText =
      text.trim();

    if (!cleanText) {
      return;
    }

    /*
     * STT itself is synchronous from the UI's point of view:
     * display the newest Sherpa hypothesis immediately.
     */
    this.liveSttText.set(
      cleanText
    );

    // A new STT chunk starts a new visual result. Keep LOCAL independent
    // and mark AI as pending only after commit.
    this.liveAiOriginal.set('');
    this.liveAiTranslation.set('');
    this.liveAiPending.set(false);

    /*
     * Translate every changed hypothesis locally.
     * Do not await it here; STT must never wait for translation.
     */
    void this.translateLiveLocally(
      cleanText
    );
  }


  private async translateLiveLocally(
    text: string
  ): Promise<void> {

    const targetLanguage =
      this.remoteLanguage();

    if (
      !targetLanguage ||
      !this.joined()
    ) {
      return;
    }

    const revision =
      ++this.liveTranslationRevision;

    /*
     * Until ML Kit returns, keep the newest STT visible and clear
     * the translation belonging to an older hypothesis.
     */
    this.liveLocalTranslation.set('');

    try {
      let translatedText =
        text;

      if (
        this.selectedLanguage !==
        targetLanguage
      ) {
        /*
         * ML Kit currently exists in the Android native app.
         * Chrome will still receive committed subtitles through SignalR.
         */
        if (
          !Capacitor.isNativePlatform() ||
          Capacitor.getPlatform() !==
          'android'
        ) {
          return;
        }

        const result =
          await this.offlineTranslation
            .translate(
              text,
              this.selectedLanguage,
              targetLanguage
            );

        translatedText =
          result.translatedText;
      }

      /*
       * Race protection:
       * "Where" may finish after "Where are".
       * Only the newest request is allowed to update the screen.
       */
      if (
        revision !==
        this.liveTranslationRevision
      ) {
        return;
      }

      this.liveLocalTranslation.set(
        translatedText
      );
      this.liveLocalSourceText = text.trim();

      this.translationLog(
        'LIVE_MLKIT',
        {
          revision,
          originalText: text,
          translatedText
        }
      );

    } catch (error) {

      if (
        revision ===
        this.liveTranslationRevision
      ) {
        console.error(
          '★★★★★ LIVE ML KIT FAILED ★★★★★',
          error
        );
      }
    }
  }


  /*
   * Sherpa FINAL can contain a correction or words not seen in the
   * latest partial. Show those words immediately, then commit them.
   */
  private async flushFinalText(
    finalText: string,
    utteranceId: number
  ): Promise<void> {

    const cleanFinal = finalText.trim();
    if (!cleanFinal) return;

    /*
     * FINAL may correct the last partial, so show/translate the exact
     * final hypothesis once before publishing it.
     */
    this.showLiveChunk(cleanFinal);

    const chunks = this.splitFinalIntoChunks(cleanFinal);

    this.translationLog('FINAL_COMMIT', {
      utteranceId,
      finalText: cleanFinal,
      chunks
    });

    for (let i = 0; i < chunks.length; i++) {
      await this.commitChunk(
        chunks[i],
        i === chunks.length - 1
      );
    }

    this.resetSherpaSegment();
  }


  private splitFinalIntoChunks(text: string): string[] {
    const words = this.splitWords(text);
    const chunks: string[] = [];
    let current: string[] = [];

    for (const word of words) {
      const candidate = [...current, word].join(' ');

      if (
        current.length > 0 &&
        (current.length >= this.maxChunkWords || candidate.length > this.maxChunkChars)
      ) {
        chunks.push(current.join(' '));
        current = [word];
      } else {
        current.push(word);
      }
    }

    if (current.length > 0) chunks.push(current.join(' '));
    return chunks;
  }


  private splitWords(
    text: string
  ): string[] {

    const clean =
      text.trim();

    if (!clean) {
      return [];
    }

    return clean.split(
      /\s+/
    );
  }


  /*
   * =========================================================
   * COMMITTED CHUNK
   * =========================================================
   *
   * LIVE path:
   * Sherpa -> UI -> ML Kit
   *
   * COMMIT path:
   * 5 words OR 650 ms pause/final -> OpenAI -> UI + SignalR/history
   */
  private async commitChunk(
    originalText: string,
    _isFinal: boolean
  ): Promise<void> {

    const cleanText = originalText.trim();
    if (!cleanText) return;

    if (cleanText === this.lastCommittedChunk) return;
    this.lastCommittedChunk = cleanText;

    const targetLanguage = this.remoteLanguage();
    if (!targetLanguage || !this.joined()) return;

    const segmentId = this.createSegmentId();
    let localTranslatedText = cleanText;

    try {
      // Reuse the rolling ML Kit result whenever it belongs to this exact text.
      if (
        this.liveLocalSourceText === cleanText &&
        this.liveLocalTranslation().trim()
      ) {
        localTranslatedText = this.liveLocalTranslation().trim();
      } else if (
        this.selectedLanguage !== targetLanguage &&
        Capacitor.isNativePlatform() &&
        Capacitor.getPlatform() === 'android'
      ) {
        const localResult = await this.offlineTranslation.translate(
          cleanText,
          this.selectedLanguage,
          targetLanguage
        );
        localTranslatedText = localResult.translatedText;
      }
    } catch (error) {
      console.error('★★★★★ COMMITTED ML KIT FAILED ★★★★★', error);
    }

    const localSubtitle: SubtitleMessage = {
      segmentId,
      originalText: cleanText,
      translatedText: localTranslatedText,
      sourceLanguage: this.selectedLanguage,
      targetLanguage,
      stage: 'local',
      requestAi: this.translationMode === 'premium'
    };

    // Sender stores LOCAL immediately. No OpenAI wait.
    this.subtitle.set(localSubtitle);
    this.latestDisplayedSegmentId = segmentId;
    this.addLocalHistory(localSubtitle);

    if (this.liveSttText().trim() === cleanText) {
      this.liveLocalTranslation.set(localTranslatedText);
      this.liveLocalSourceText = cleanText;
      this.liveAiOriginal.set('');
      this.liveAiTranslation.set('');
      this.liveAiPending.set(localSubtitle.requestAi);
    }

    try {
      // Hub relays LOCAL immediately, then only QUEUES OpenAI.
      // This await waits for the short Hub invocation, NOT for OpenAI.
      await this.signalR.sendSubtitle(
        this.sessionId.trim(),
        localSubtitle
      );

      this.translationLog('LOCAL_SIGNALR_SENT', {
        segmentId,
        originalText: cleanText,
        translatedText: localTranslatedText,
        requestAi: localSubtitle.requestAi
      });
    } catch (error) {
      console.error('★★★★★ LOCAL SUBTITLE SIGNALR FAILED ★★★★★', error);
      if (this.latestDisplayedSegmentId === segmentId) {
        this.liveAiPending.set(false);
      }
    }
  }


  setTranslationMode(
    mode: 'free' | 'premium'
  ): void {

    this.translationMode =
      mode;

    localStorage.setItem(
      'lingo-translation-mode',
      mode
    );

    this.translationLog(
      'TRANSLATION_MODE_CHANGED',
      {
        mode
      }
    );
  }


  /*
   * =========================================================
   * SUBTITLE HISTORY
   * =========================================================
   */


  private addLocalHistory(subtitle: SubtitleMessage): void {
    this.localHistory.update(history => {
      if (history.some(item => item.segmentId === subtitle.segmentId)) return history;
      return [...history, subtitle];
    });
    this.keepHistoryAtBottomIfNeeded();
  }

  private addAiHistory(subtitle: SubtitleMessage): void {
    this.aiHistory.update(history => {
      const index = history.findIndex(item => item.segmentId === subtitle.segmentId);
      if (index < 0) {
        return [...history, subtitle].sort((a, b) =>
          this.segmentOrder(a.segmentId) - this.segmentOrder(b.segmentId)
        );
      }
      const copy = [...history];
      copy[index] = subtitle;
      return copy;
    });
    this.keepHistoryAtBottomIfNeeded();
  }

  private segmentOrder(segmentId: string): number {
    const timestamp = Number(segmentId.split('-')[0]);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  setActiveHistory(tab: 'local' | 'ai'): void {
    this.activeHistory.set(tab);
    setTimeout(() => this.scrollHistoryToBottom(), 0);
  }

  toggleHistory(): void {
    const opening = !this.historyOpen();
    this.historyOpen.set(opening);
    if (opening) setTimeout(() => this.scrollHistoryToBottom(), 0);
  }

  private keepHistoryAtBottomIfNeeded(): void {
    if (!this.historyOpen()) return;
    const el = document.querySelector('.history-content') as HTMLElement | null;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance <= 80) setTimeout(() => this.scrollHistoryToBottom(), 0);
  }

  private scrollHistoryToBottom(): void {
    const el = document.querySelector('.history-content') as HTMLElement | null;
    if (el) el.scrollTop = el.scrollHeight;
  }


  /*
   * Reset state belonging to one Sherpa
   * recognition stream.
   *
   * Subtitle history is intentionally NOT
   * cleared here.
   */
  private resetSherpaSegment():
    void {

    this.cancelTranslationTimer();

    this.currentUtteranceId = 0;

    /*
     * Invalidate any ML Kit request that still belongs to the
     * previous live hypothesis.
     */
    this.liveTranslationRevision++;

    // Keep the last committed subtitle visible until the next partial arrives.
    this.liveLocalSourceText = '';

    /*
     * Allow the same phrase to be spoken again in a new Sherpa stream.
     */
    this.lastCommittedChunk = '';

    this.segmentCounter++;


    this.translationLog(
      'SHERPA_SEGMENT_RESET',
      {
        segmentCounter:
          this.segmentCounter
      }
    );
  }


  private createSegmentId():
    string {

    /*
     * Date + monotonically increasing counter
     * gives each local subtitle chunk a
     * different ID.
     */
    this.segmentCounter++;

    return `${Date.now()}-${this.segmentCounter}`;
  }


  private cancelTranslationTimer():
    void {

    if (
      this.translationTimer !==
      undefined
    ) {

      clearTimeout(
        this.translationTimer
      );

      this.translationTimer =
        undefined;
    }
  }


  /*
   * =========================================================
   * WEBRTC SIGNALING
   * =========================================================
   */


  private registerWebRtcSignaling():
    void {

    this.signalR.onWebRtcOffer(
      async offer => {

        console.log(
          'WEBRTC OFFER RECEIVED',
          offer
        );

        await this.ensureWebRtc();


        const answer =
          await this.webRtc.acceptOffer(
            offer
          );


        await this.signalR
          .sendWebRtcAnswer(
            this.sessionId.trim(),
            answer
          );


        this.bindVideoStreams();
      }
    );


    this.signalR.onWebRtcAnswer(
      async answer => {

        await this.webRtc.acceptAnswer(
          answer
        );

        this.bindVideoStreams();
      }
    );


    this.signalR.onIceCandidate(
      async candidate => {

        await this.webRtc
          .addIceCandidate(
            candidate
          );
      }
    );
  }


  private async ensureWebRtc():
    Promise<void> {

    await this.webRtc
      .createPeerConnection(
        async candidate => {

          await this.signalR
            .sendIceCandidate(
              this.sessionId.trim(),
              candidate
            );
        }
      );


    this.bindVideoStreams();
  }


  /*
   * =========================================================
   * MANUAL TEXT CHAT
   * =========================================================
   */


  async send():
    Promise<void> {

    const text =
      this.messageText.trim();


    if (
      !text ||
      !this.joined()
    ) {
      return;
    }


    await this.signalR.sendText(
      this.sessionId.trim(),
      text
    );


    this.messages.update(
      messages => [
        ...messages,
        {
          text,
          direction: 'sent'
        }
      ]
    );


    this.messageText = '';
  }


  toggleMicrophone(): void {
    const enabled = !this.microphoneEnabled();
    this.microphoneEnabled.set(enabled);
    this.webRtc.setMicrophoneEnabled(enabled);
  }


  toggleCamera(): void {
    const enabled = !this.cameraEnabled();
    this.cameraEnabled.set(enabled);
    this.webRtc.setCameraEnabled(enabled);
  }


  toggleSubtitles(): void {
    this.subtitlesVisible.update(visible => !visible);
  }


  toggleColorTheme(): void {
    const next = this.colorTheme() === 'azure' ? 'indigo' : 'azure';
    this.colorTheme.set(next);
    localStorage.setItem('lingo-color-theme', next);
  }


  toggleTranslationMode(): void {
    this.setTranslationMode(
      this.translationMode === 'premium' ? 'free' : 'premium'
    );
  }


  /*
   * =========================================================
   * CALL
   * =========================================================
   */


  async startCall():
    Promise<void> {

    if (!this.joined()) {
      return;
    }


    /*
     * New call = clean subtitle state.
     */
    this.resetSherpaSegment();

    this.lastHandledFinalUtteranceId = 0;

    this.subtitle.set(
      null
    );

    this.microphoneEnabled.set(true);
    this.cameraEnabled.set(true);
    this.subtitlesVisible.set(true);


    await this.webRtc
      .createPeerConnection(
        async candidate => {

          await this.signalR
            .sendIceCandidate(
              this.sessionId.trim(),
              candidate
            );
        },
        true
      );


    const offer =
      await this.webRtc.createOffer();


    await this.signalR
      .sendWebRtcOffer(
        this.sessionId.trim(),
        offer
      );
  }


  async endCall():
    Promise<void> {

    this.cancelTranslationTimer();

    this.resetSherpaSegment();

    this.lastHandledFinalUtteranceId = 0;

    this.subtitle.set(
      null
    );


    await this.webRtc.endCall();
  }


  /*
   * =========================================================
   * VIDEO
   * =========================================================
   */


  private bindVideoStreams():
    void {

    const local =
      this.webRtc.localMediaStream();

    const remote =
      this.webRtc.remoteMediaStream();


    if (
      local &&
      this.localVideo
    ) {

      this.localVideo
        .nativeElement
        .srcObject = local;
    }


    if (
      remote &&
      this.remoteVideo
    ) {

      this.remoteVideo
        .nativeElement
        .srcObject = remote;
    }
  }


  /*
   * =========================================================
   * DESTROY
   * =========================================================
   */


  async ngOnDestroy():
    Promise<void> {

    this.cancelTranslationTimer();


    if (this.joined()) {

      await this.signalR
        .leaveSession(
          this.sessionId.trim()
        );
    }


    await this.signalR.disconnect();
  }


  /*
   * =========================================================
   * DEBUG
   * =========================================================
   */


  private translationLog(
    event: string,
    data: Record<string, unknown> = {}
  ): void {

    console.log(
      '★★★★★ LINGO_TRANSLATION',
      event,
      JSON.stringify({
        time: Date.now(),
        ...data
      }),
      '★★★★★'
    );
  }
}

