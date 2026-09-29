
import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
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

import { Capacitor, registerPlugin } from '@capacitor/core';



import {
  OfflineTranslationService
} from '../../../core/services/offline-translation.service';


import {
  environment
} from '../../../../environments/environment';

import {
  WebRtcService
} from '../../../core/services/web-rtc.service';

import {
  SpeechRecognitionService
} from '../../../core/services/speech-recognition.service';
import { ParticipantInfo, SubtitleMessage, TranslationSignalRService } from '../../../core/services/translation-signal-r';


interface ConversationMessage {
  text: string;
  direction: 'sent' | 'received';
}

interface NativeWebRtcSubtitleBridge {
  setSubtitleOverlay(options: {
    originalText: string;
    localTranslation: string;
    aiTranslation: string;
    aiPending: boolean;
    visible: boolean;
  }): Promise<void>;
}

const NativeWebRtcSubtitle =
  registerPlugin<NativeWebRtcSubtitleBridge>('NativeWebRtc');



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
  implements AfterViewInit, OnDestroy {

  @ViewChild('localVideo')
  private localVideo?:
    ElementRef<HTMLVideoElement>;

  @ViewChild('remoteVideo')
  private remoteVideo?:
    ElementRef<HTMLVideoElement>;


  /*
   * Android native WebRTC renderer placeholders.
   *
   * These elements do NOT render video themselves.
   * Their DOM bounds tell Kotlin where native
   * SurfaceViewRenderer views belong.
   */

  @ViewChild('nativeRemoteVideo')
  private nativeRemoteVideo?:
    ElementRef<HTMLDivElement>;

  @ViewChild('nativeLocalVideo')
  private nativeLocalVideo?:
    ElementRef<HTMLDivElement>;

  readonly nativeAndroid =
    Capacitor.isNativePlatform() &&
    Capacitor.getPlatform() === 'android';

  private readonly signalR =
    inject(TranslationSignalRService);

  private readonly offlineTranslation =
    inject(OfflineTranslationService);

  private nativeVideoResizeObserver?:
    ResizeObserver;

  private nativeVideoLayoutFrame:
    number | null = null;

  private nativeVideoLayoutActive =
    false;


  private readonly nativeVideoWindowChanged =
    () => {

      this.scheduleNativeVideoLayout();
    };

  private readonly nativeVideoScrollChanged =
    () => {

      this.scheduleNativeVideoLayout();
    };

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

  readonly remoteParticipant =
    signal<ParticipantInfo | null>(null);

  subtitle =
    signal<SubtitleMessage | null>(null);

  /*
   * LIVE subtitle pipeline:
   * - liveSttText: newest complete Sherpa hypothesis for the active utterance
   * - liveLocalTranslation: ML Kit translation of that exact hypothesis
   * - liveAiOriginal/liveAiTranslation: OpenAI result for the last committed chunk
   *
   * ML Kit is allowed to revise continuously as Sherpa revises its partial.
   * OpenAI runs only after Sherpa FINAL; long finals may be split for history/network.
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

  // Diagnostic only: sender-side monotonic-enough wall-clock marker per subtitle.
  // Used with receiver render ACK so both events are visible in Android logcat.
  private readonly subtitleSendStartedAt = new Map<string, number>();

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
   * Number of words from the current
   * Sherpa stream that have already been
   * consumed by subtitle chunks.
   */
  private consumedWords = 0;

  /*
   * Latest complete partial returned by
   * Sherpa for the current stream.
   */
  private latestPartialText = '';

  /*
   * Used to prevent processing the same
   * FINAL signal twice.
   */
  private lastObservedFinal = '';

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
   * Subtitle chunking rules.
   *
   * 5 words:
   * preferred immediate subtitle size.
   *
   * 6 words:
   * absolute maximum when Sherpa jumps
   * over the 5-word boundary.
   *
   * Active partials commit during speech: 5 words immediately,
   * or the remaining 1-4 words after 650 ms without a newer partial.
   */
  private readonly targetChunkWords = 5;

  private readonly targetChunkChars = 30;

  private readonly maxChunkWords = 5;

  private readonly pauseMs = 650;


  private translationTimer:
    ReturnType<typeof setTimeout> | undefined;



  constructor() {

    /*
     * Android native video is composited above the Capacitor WebView.
     * Therefore the live subtitle card must also be a native Android view.
     * Angular remains the single source of truth for subtitle state.
     */
    effect(() => {
      if (!this.nativeAndroid) {
        return;
      }

      const sttState = this.speech.state();
      const sttInitializing =
        this.webRtc.callConnected() &&
        sttState !== 'ready' &&
        sttState !== 'speaking' &&
        sttState !== 'processing';

      const originalText = sttInitializing
        ? 'Pokretanje prepoznavanja govora…'
        : this.liveSttText();
      const localTranslation = sttInitializing
        ? ''
        : this.liveLocalTranslation();
      const aiTranslation = this.liveAiTranslation();
      const aiPending = this.liveAiPending();
      const visible = this.subtitlesVisible();

      void NativeWebRtcSubtitle
        .setSubtitleOverlay({
          originalText,
          localTranslation,
          aiTranslation,
          aiPending,
          visible
        })
        .catch(error => {
          console.error(
            '★★★★★ NATIVE SUBTITLE OVERLAY FAILED ★★★★★',
            error
          );
        });
    });

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


        if (this.nativeAndroid) {

          this.nativeVideoLayoutActive =
            true;

          this.scheduleNativeVideoLayout();
        }

      } else {

        console.log(
          '★★★★★ STOPPING STT ★★★★★'
        );


        void this.speech.stop();


        if (this.nativeAndroid) {

          this.nativeVideoLayoutActive =
            false;

          void this.webRtc
            .hideNativeVideoRenderers();
        }
      }
    });
    /*
     * Observe Sherpa partials.
     *
     * We no longer translate the whole
     * growing Sherpa sentence.
     *
     * Instead we keep track of words that
     * have already been consumed.
     *
     * Rules:
     *
     * 1-4 new words:
     * wait for more speech, but only for
     * at most 650 ms.
     *
     * 5 new words:
     * translate immediately.
     *
     * 6+ new words:
     * translate immediately and never put
     * more than 6 words into one chunk.
     */
    effect(() => {

      const partial =
        this.speech.partialText().trim();

      this.translationLog(
        'STT_PARTIAL',
        {
          text: partial,

          words: partial
            ? this.splitWords(partial).length
            : 0,

          consumedWords:
            this.consumedWords
        }
      );

      if (!partial) {
        return;
      }

      this.latestPartialText =
        partial;

      this.processPartial(
        partial
      );
    });


    /*
     * Sherpa FINAL.
     *
     * Only words that were NOT already
     * translated are flushed here.
     */
    effect(() => {

      const finalText =
        this.speech.finalText().trim();

      if (!finalText) {
        return;
      }

      if (
        finalText ===
        this.lastObservedFinal
      ) {
        return;
      }

      this.lastObservedFinal =
        finalText;

      this.cancelTranslationTimer();

      this.translationLog(
        'STT_FINAL',
        {
          text:
            finalText,

          words:
            this.splitWords(
              finalText
            ).length,

          consumedWords:
            this.consumedWords
        }
      );

      void this.flushFinalText(
        finalText
      );
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

    this.lastObservedFinal = '';

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
      .onParticipantChanged(
        participant => {
          console.log(
            '★★★★★ REMOTE PARTICIPANT:',
            participant,
            '★★★★★'
          );

          this.remoteParticipant.set(participant);
          this.remoteLanguage.set(participant.language);
        }
      );


    this.signalR
      .onParticipantLeft(
        () => {

          this.remoteLanguage.set(null);
          this.remoteParticipant.set(null);
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
          void this.handleReceivedSubtitle(subtitle);
        }
      );

    this.signalR
      .onSubtitleRenderedAck(
        ack => {
          const sendStartedAt =
            this.subtitleSendStartedAt.get(ack.segmentId);

          const ackReceivedAt = Date.now();

          this.translationLog('REMOTE_RENDERED_ACK', {
            segmentId: ack.segmentId,
            sendStartedAt,
            receiverReceivedAt: ack.receiverReceivedAt,
            receiverRenderedAt: ack.receiverRenderedAt,
            ackReceivedAt,
            roundTripToRenderedAckMs:
              sendStartedAt === undefined
                ? null
                : ackReceivedAt - sendStartedAt,
            receiverReportedSendToRenderMs:
              ack.senderSentAt > 0
                ? ack.receiverRenderedAt - ack.senderSentAt
                : null
          });

          this.subtitleSendStartedAt.delete(ack.segmentId);
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

    const platform: ParticipantInfo['platform'] =
      Capacitor.isNativePlatform()
        ? (Capacitor.getPlatform() === 'ios' ? 'ios' : 'android')
        : 'web';

    await this.signalR.joinSession(
      sessionId,
      this.selectedLanguage,
      {
        language: this.selectedLanguage,
        platform,
        localTranslation:
          platform === 'android'
      }
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
    fullText: string
  ): void {

    if (
      !this.joined() ||
      !this.remoteLanguage()
    ) {
      return;
    }

    const cleanText =
      fullText.trim();

    if (!cleanText) {
      return;
    }

    /*
     * Sherpa partial is the complete mutable hypothesis for the
     * current utterance. Keep showing/translating the full rolling
     * hypothesis locally, but commit stable-sized chunks during speech.
     */
    this.latestPartialText =
      cleanText;

    this.showLiveChunk(
      cleanText
    );

    const words =
      this.splitWords(
        cleanText
      );

    /*
     * Sherpa can revise the current hypothesis. Words already sent as
     * subtitle chunks belong to older chunks and must never be resent.
     */
    if (
      words.length <
      this.consumedWords
    ) {
      this.translationLog(
        'PARTIAL_SHORTER_THAN_CONSUMED',
        {
          text: cleanText,
          words: words.length,
          consumedWords: this.consumedWords
        }
      );
      return;
    }

    let remaining =
      words.slice(
        this.consumedWords
      );

    if (remaining.length === 0) {
      return;
    }

    /* New speech invalidates the previous pause flush. */
    this.cancelTranslationTimer();

    /*
     * Commit while the speaker is still talking.
     * Five words is the target chunk size used by the original working
     * behavior. The full mutable partial remains visible locally.
     */
    while (
      remaining.length >=
      this.targetChunkWords
    ) {
      const chunkWords =
        remaining.slice(
          0,
          this.maxChunkWords
        );

      const chunk =
        chunkWords.join(' ');

      this.translationLog(
        'WORD_LIMIT_FLUSH',
        {
          chunk,
          chunkWords: chunkWords.length,
          availableWords: remaining.length,
          consumedBefore: this.consumedWords
        }
      );

      /* Mark consumed before async work to prevent duplicate sends. */
      this.consumedWords +=
        chunkWords.length;

      void this.commitChunk(
        chunk,
        false
      );

      remaining =
        words.slice(
          this.consumedWords
        );
    }

    /*
     * One to four remaining words are flushed after 650 ms without a
     * newer partial. If speech continues, the next partial cancels it.
     */
    if (remaining.length > 0) {
      this.schedulePauseFlush();
    }
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



  private schedulePauseFlush():
    void {

    this.cancelTranslationTimer();

    this.translationLog(
      'PAUSE_TIMER_STARTED',
      {
        pauseMs: this.pauseMs,
        consumedWords: this.consumedWords,
        latestPartialText: this.latestPartialText
      }
    );

    this.translationTimer =
      setTimeout(
        () => {
          this.translationTimer =
            undefined;

          const words =
            this.splitWords(
              this.latestPartialText
            );

          const remaining =
            words.slice(
              this.consumedWords
            );

          if (remaining.length === 0) {
            return;
          }

          const chunkWords =
            remaining.slice(
              0,
              this.maxChunkWords
            );

          const text =
            chunkWords.join(' ');

          this.translationLog(
            'PAUSE_FLUSH',
            {
              text,
              words: chunkWords.length,
              consumedBefore: this.consumedWords
            }
          );

          this.consumedWords +=
            chunkWords.length;

          void this.commitChunk(
            text,
            false
          );

          const stillRemaining =
            words.length -
            this.consumedWords;

          if (stillRemaining > 0) {
            this.processPartial(
              this.latestPartialText
            );
          }
        },
        this.pauseMs
      );
  }


  /*
   * Sherpa FINAL is authoritative for the utterance, but partial chunks
   * may already have been sent. Commit only words not yet consumed.
   */
  private async flushFinalText(
    finalText: string
  ): Promise<void> {

    this.cancelTranslationTimer();

    const cleanFinal =
      finalText.trim();

    if (!cleanFinal) {
      this.resetSherpaSegment();
      return;
    }

    /* Keep the exact FINAL visible locally. */
    this.latestPartialText =
      cleanFinal;

    this.showLiveChunk(
      cleanFinal
    );

    const words =
      this.splitWords(
        cleanFinal
      );

    if (
      words.length <=
      this.consumedWords
    ) {
      this.translationLog(
        'FINAL_NO_NEW_WORDS',
        {
          finalText: cleanFinal,
          finalWords: words.length,
          consumedWords: this.consumedWords
        }
      );

      this.resetSherpaSegment();
      return;
    }

    let remaining =
      words.slice(
        this.consumedWords
      );

    while (remaining.length > 0) {
      const chunkWords =
        remaining.slice(
          0,
          this.maxChunkWords
        );

      remaining =
        remaining.slice(
          chunkWords.length
        );

      const text =
        chunkWords.join(' ');

      const isLast =
        remaining.length === 0;

      this.translationLog(
        'FINAL_FLUSH',
        {
          text,
          words: chunkWords.length,
          isLast,
          consumedBefore: this.consumedWords
        }
      );

      this.consumedWords +=
        chunkWords.length;

      await this.commitChunk(
        text,
        isLast
      );
    }

    this.resetSherpaSegment();
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
    const remote = this.remoteParticipant();
    const receiverTranslatesLocally =
      remote?.localTranslation === true;

    /*
     * MOBILE -> MOBILE:
     * Do not wait for sender-side ML Kit. Send the authoritative STT
     * immediately; the receiver translates into its own language.
     *
     * MOBILE -> WEB TEST FALLBACK:
     * Browser currently has no local ML Kit translator, so the Android
     * sender still translates before sending.
     */
    let localTranslatedText =
      this.liveLocalSourceText === cleanText &&
      this.liveLocalTranslation().trim()
        ? this.liveLocalTranslation().trim()
        : cleanText;

    if (
      !receiverTranslatesLocally &&
      this.selectedLanguage !== targetLanguage &&
      Capacitor.isNativePlatform() &&
      Capacitor.getPlatform() === 'android' &&
      localTranslatedText === cleanText
    ) {
      try {
        const localResult = await this.offlineTranslation.translate(
          cleanText,
          this.selectedLanguage,
          targetLanguage
        );
        localTranslatedText = localResult.translatedText;
      } catch (error) {
        console.error('★★★★★ CHROME FALLBACK ML KIT FAILED ★★★★★', error);
      }
    }

    const outgoingSubtitle: SubtitleMessage = {
      segmentId,
      senderSentAt: 0,
      originalText: cleanText,
      translatedText: receiverTranslatesLocally
        ? cleanText
        : localTranslatedText,
      sourceLanguage: this.selectedLanguage,
      targetLanguage,
      stage: 'local',
      requestAi: false
    };

    // Sender UI may keep showing its already available rolling ML Kit result.
    // It is not part of the mobile->mobile network critical path.
    this.subtitle.set({
      ...outgoingSubtitle,
      translatedText: localTranslatedText
    });
    this.latestDisplayedSegmentId = segmentId;
    this.addLocalHistory({
      ...outgoingSubtitle,
      translatedText: localTranslatedText
    });

    if (this.liveSttText().trim() === cleanText) {
      this.liveLocalTranslation.set(localTranslatedText);
      this.liveLocalSourceText = cleanText;
      this.liveAiOriginal.set('');
      this.liveAiTranslation.set('');
      this.liveAiPending.set(false);
    }

    try {
      const sendStartedAt = Date.now();
      outgoingSubtitle.senderSentAt = sendStartedAt;
      this.subtitleSendStartedAt.set(segmentId, sendStartedAt);

      this.translationLog('SUBTITLE_SEND_START', {
        segmentId,
        senderSentAt: sendStartedAt,
        originalText: cleanText,
        translatedText: outgoingSubtitle.translatedText,
        remotePlatform: remote?.platform ?? 'unknown'
      });

      await this.signalR.sendSubtitle(
        this.sessionId.trim(),
        outgoingSubtitle
      );

      this.translationLog('LOCAL_SIGNALR_SENT', {
        segmentId,
        originalText: cleanText,
        translatedText: outgoingSubtitle.translatedText,
        receiverTranslatesLocally,
        remotePlatform: remote?.platform ?? 'unknown',
        requestAi: false
      });
    } catch (error) {
      console.error('★★★★★ LOCAL SUBTITLE SIGNALR FAILED ★★★★★', error);
    }
  }

  private async handleReceivedSubtitle(
    incoming: SubtitleMessage
  ): Promise<void> {

    const receiverReceivedAt = Date.now();

    this.translationLog('SUBTITLE_RECEIVED', {
      segmentId: incoming.segmentId,
      senderSentAt: incoming.senderSentAt,
      receiverReceivedAt,
      apparentNetworkMs:
        incoming.senderSentAt > 0
          ? receiverReceivedAt - incoming.senderSentAt
          : null
    });

    const originalText = incoming.originalText.trim();
    if (!originalText) return;

    let translatedText = incoming.translatedText?.trim() || originalText;

    // Final mobile architecture: the receiving Android translates the
    // speaker's STT into its own selected language.
    if (
      Capacitor.isNativePlatform() &&
      Capacitor.getPlatform() === 'android' &&
      incoming.sourceLanguage !== this.selectedLanguage
    ) {
      try {
        const result = await this.offlineTranslation.translate(
          originalText,
          incoming.sourceLanguage,
          this.selectedLanguage
        );
        translatedText = result.translatedText;
      } catch (error) {
        console.error('★★★★★ RECEIVER ML KIT FAILED ★★★★★', error);
        // Keep sender-provided fallback if translation fails.
      }
    }

    const subtitle: SubtitleMessage = {
      ...incoming,
      translatedText,
      targetLanguage: this.selectedLanguage,
      requestAi: false
    };

    this.subtitle.set(subtitle);
    this.latestDisplayedSegmentId = subtitle.segmentId;
    this.liveSttText.set(originalText);
    this.liveLocalTranslation.set(translatedText);
    this.liveLocalSourceText = originalText;
    this.liveAiOriginal.set('');
    this.liveAiTranslation.set('');
    this.liveAiPending.set(false);
    this.addLocalHistory(subtitle);

    this.translationLog('REMOTE_LOCAL_TRANSLATED', {
      segmentId: subtitle.segmentId,
      sourceLanguage: incoming.sourceLanguage,
      targetLanguage: this.selectedLanguage,
      originalText,
      translatedText
    });

    // Wait until Angular has had two browser paint opportunities.
    // The ACK is diagnostic only and never participates in subtitle delivery.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const receiverRenderedAt = Date.now();

        this.translationLog('SUBTITLE_RENDERED', {
          segmentId: subtitle.segmentId,
          senderSentAt: incoming.senderSentAt,
          receiverReceivedAt,
          receiverRenderedAt,
          apparentSendToRenderMs:
            incoming.senderSentAt > 0
              ? receiverRenderedAt - incoming.senderSentAt
              : null
        });

        void this.signalR
          .sendSubtitleRenderedAck(
            this.sessionId.trim(),
            {
              segmentId: subtitle.segmentId,
              senderSentAt: incoming.senderSentAt,
              receiverReceivedAt,
              receiverRenderedAt
            }
          )
          .catch(error => {
            console.error(
              '★★★★★ SUBTITLE RENDER ACK FAILED ★★★★★',
              error
            );
          });
      });
    });
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

  async toggleHistory(): Promise<void> {
    const opening = !this.historyOpen();
    this.historyOpen.set(opening);

    // Android video uses native SurfaceViewRenderers above the WebView.
    // Hide them while history is open so the history panel and its Close
    // button remain fully interactive. Restore their layout when closing.
    if (this.nativeAndroid && this.webRtc.callConnected()) {
      if (opening) {
        await this.webRtc.hideNativeVideoRenderers();
      } else {
        this.nativeVideoLayoutActive = true;
        this.scheduleNativeVideoLayout();
      }
    }

    if (opening) {
      setTimeout(() => this.scrollHistoryToBottom(), 0);
    }
  }

  async closeHistory(): Promise<void> {
    if (!this.historyOpen()) {
      return;
    }

    await this.toggleHistory();
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
   * Reset only rolling/chunk state when a new native Sherpa
   * utterance is detected. Do not clear history, WebRTC or STT.
   */
  private resetChunkStateForNewUtterance():
    void {

    this.cancelTranslationTimer();

    this.consumedWords = 0;

    this.latestPartialText = '';

    this.liveTranslationRevision++;

    this.liveLocalSourceText = '';

    this.lastCommittedChunk = '';

    /*
     * Prevent a late AI result from the previous committed segment
     * from being attached visually to a new uncommitted hypothesis.
     */
    this.latestDisplayedSegmentId = '';

    this.translationLog(
      'CHUNK_STATE_RESET',
      {
        segmentCounter:
          this.segmentCounter
      }
    );
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

    this.consumedWords = 0;

    this.latestPartialText = '';

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


    if (this.nativeAndroid) {

      this.nativeVideoLayoutActive = true;

      this.scheduleNativeVideoLayout();

    } else {
      this.bindVideoStreams();
    }
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


  async toggleMicrophone():
    Promise<void> {

    const enabled =
      !this.microphoneEnabled();


    this.microphoneEnabled.set(
      enabled
    );


    await this.webRtc
      .setMicrophoneEnabled(
        enabled
      );
  }


  async toggleCamera():
    Promise<void> {

    const enabled = !this.cameraEnabled();


    this.cameraEnabled.set(enabled);


    await this.webRtc
      .setCameraEnabled(
        enabled
      );
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

    this.lastObservedFinal = '';

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

    if (this.nativeAndroid) {

      this.nativeVideoLayoutActive =
        true;


      this.scheduleNativeVideoLayout();
    }


    const offer = await this.webRtc.createOffer();

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

    this.lastObservedFinal = '';

    this.subtitle.set(null);


    this.nativeVideoLayoutActive = false;


    if (this.nativeAndroid) {
      await this.webRtc.hideNativeVideoRenderers();
    }

    await this.speech.stop();

    await this.webRtc.endCall();
  }


  async leaveSession():
    Promise<void> {

    const sessionId = this.sessionId.trim();

    // End media/STT first if a call is still active.
    if (this.webRtc.callConnected()) {
      await this.endCall();
    } else {
      this.cancelTranslationTimer();
      this.resetSherpaSegment();
      this.lastObservedFinal = '';
      this.subtitle.set(null);
      await this.speech.stop();
    }

    if (this.historyOpen()) {
      this.historyOpen.set(false);
    }

    if (this.joined() && sessionId) {
      await this.signalR.leaveSession(sessionId);
    }

    this.joined.set(false);
    this.remoteLanguage.set(null);
    this.remoteParticipant.set(null);

    this.liveSttText.set('');
    this.liveLocalTranslation.set('');
    this.liveAiOriginal.set('');
    this.liveAiTranslation.set('');
    this.liveAiPending.set(false);

    this.localHistory.set([]);
    this.aiHistory.set([]);
    this.messages.set([]);

    this.microphoneEnabled.set(true);
    this.cameraEnabled.set(true);
    this.subtitlesVisible.set(true);
  }


  /*
   * =========================================================
   * VIDEO
   * =========================================================
   */


  private bindVideoStreams():
    void {

    /*
     * =========================================================
     * ANDROID
     * =========================================================
     *
     * There is deliberately NO HTML MediaStream.
     *
     * NativeWebRtc owns the VideoTracks and Kotlin attaches
     * them to SurfaceViewRenderer.
     *
     * Angular only supplies renderer bounds.
     */

    if (this.nativeAndroid) {

      this.nativeVideoLayoutActive =
        true;


      this.scheduleNativeVideoLayout();

      return;
    }


    /*
     * =========================================================
     * BROWSER / CHROME
     * =========================================================
     */

    const local =
      this.webRtc.localMediaStream();

    const remote =
      this.webRtc.remoteMediaStream();


    if (
      local &&
      this.localVideo
    ) {

      const element =
        this.localVideo.nativeElement;


      if (
        element.srcObject !==
        local
      ) {

        element.srcObject =
          local;
      }


      void element
        .play()
        .catch(
          () => {
          }
        );
    }


    if (
      remote &&
      this.remoteVideo
    ) {

      const element =
        this.remoteVideo.nativeElement;


      if (
        element.srcObject !==
        remote
      ) {

        element.srcObject =
          remote;
      }


      void element
        .play()
        .catch(
          () => {
          }
        );
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


    this.nativeVideoLayoutActive =
      false;


    if (
      this.nativeVideoLayoutFrame !==
      null
    ) {

      cancelAnimationFrame(
        this.nativeVideoLayoutFrame
      );

      this.nativeVideoLayoutFrame =
        null;
    }


    this.nativeVideoResizeObserver
      ?.disconnect();

    this.nativeVideoResizeObserver =
      undefined;


    window.removeEventListener(
      'resize',
      this.nativeVideoWindowChanged
    );


    window.removeEventListener(
      'orientationchange',
      this.nativeVideoWindowChanged
    );


    window.removeEventListener(
      'scroll',
      this.nativeVideoScrollChanged,
      true
    );


    /*
     * Stop STT first.
     *
     * This removes Sherpa as PCM consumer.
     */

    await this.speech.stop();


    /*
     * Full release because the conversation page itself
     * is being destroyed.
     */

    await this.webRtc.release();


    if (this.joined()) {

      await this.signalR
        .leaveSession(
          this.sessionId.trim()
        );
    }


    await this.signalR.disconnect();
  }

  ngAfterViewInit():
    void {

    if (!this.nativeAndroid) {
      return;
    }


    window.addEventListener(
      'resize',
      this.nativeVideoWindowChanged
    );


    window.addEventListener(
      'orientationchange',
      this.nativeVideoWindowChanged
    );


    window.addEventListener(
      'scroll',
      this.nativeVideoScrollChanged,
      true
    );


    /*
     * Ionic call screen / video stage can change size
     * without a browser resize event.
     */

    this.nativeVideoResizeObserver =
      new ResizeObserver(
        () => {

          this.scheduleNativeVideoLayout();
        }
      );


    if (
      this.nativeRemoteVideo
    ) {

      this.nativeVideoResizeObserver
        .observe(
          this.nativeRemoteVideo
            .nativeElement
        );
    }


    if (
      this.nativeLocalVideo
    ) {

      this.nativeVideoResizeObserver
        .observe(
          this.nativeLocalVideo
            .nativeElement
        );
    }
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

  private scheduleNativeVideoLayout():
    void {

    if (
      !this.nativeAndroid ||
      !this.nativeVideoLayoutActive
    ) {

      return;
    }


    if (
      this.nativeVideoLayoutFrame !==
      null
    ) {

      cancelAnimationFrame(
        this.nativeVideoLayoutFrame
      );
    }


    this.nativeVideoLayoutFrame =
      requestAnimationFrame(
        () => {

          this.nativeVideoLayoutFrame =
            null;


          /*
           * Wait one additional frame so Angular/Ionic has
           * completed the current layout.
           */

          requestAnimationFrame(
            () => {

              void this
                .updateNativeVideoLayout();
            }
          );
        }
      );
  }


  private async updateNativeVideoLayout():
    Promise<void> {

    if (
      !this.nativeAndroid ||
      !this.nativeVideoLayoutActive
    ) {

      return;
    }


    const remote =
      this.nativeRemoteVideo
        ?.nativeElement;

    const local =
      this.nativeLocalVideo
        ?.nativeElement;


    if (
      !remote ||
      !local
    ) {

      return;
    }


    /*
     * If the call screen is currently display:none,
     * getBoundingClientRect() will return zero bounds.
     */

    if (
      remote.offsetWidth <= 0 ||
      remote.offsetHeight <= 0
    ) {

      return;
    }


    try {

      await this.webRtc
        .setNativeVideoLayout(
          remote,
          local
        );

    } catch (
    error
    ) {

      console.error(
        '★★★★★ NATIVE VIDEO LAYOUT FAILED ★★★★★',
        error
      );
    }
  }
}

