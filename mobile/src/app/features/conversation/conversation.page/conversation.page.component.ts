
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
  SubtitleMessage,
  TranslationSignalRService
} from '../../../core/services/translation-signal-r';

import {
  OfflineTranslationService
} from '../../../core/services/offline-translation.service';

import {
  PremiumTranslationService
} from '../../../core/services/premium-translation.service';

import {
  environment
} from '../../../../environments/environment';

import {
  WebRtcService
} from '../../../core/services/web-rtc.service';

import {
  SpeechRecognitionService
} from '../../../core/services/speech-recognition.service';


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

  private readonly premiumTranslation =
    inject(PremiumTranslationService);

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
  readonly subtitleHistory =
    signal<SubtitleMessage[]>([]);

  readonly historyOpen =
    signal(false);

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
   * 650 ms:
   * if the speaker pauses with only
   * 1-4 pending words, translate them too.
   */
  private readonly targetChunkWords = 5;

  private readonly maxChunkWords = 5;

  private readonly pauseMs = 350;


  private translationTimer:
    ReturnType<typeof setTimeout> | undefined;

  /*
   * All translation jobs are serialized.
   *
   * This is important for Premium:
   * chunk 2 must not overtake chunk 1, and
   * when chunk 2 starts, chunk 1 is already
   * available in subtitleHistory as context.
   */
  private translationQueue:
    Promise<void> = Promise.resolve();


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

          this.translationLog(
            'SIGNALR_RECEIVED',
            {
              segmentId:
                subtitle.segmentId,

              originalText:
                subtitle.originalText,

              translatedText:
                subtitle.translatedText,

              isFinal:
                subtitle.isFinal
            }
          );

          this.subtitle.set(
            subtitle
          );

          // Remote side must show the same 3-line view as the sender.
          // isFinal=false = fast Sherpa + local/ML Kit result.
          // isFinal=true  = later OpenAI correction/translation for same segment.
          if (!subtitle.isFinal) {
            this.liveSttText.set(subtitle.originalText);
            this.liveLocalTranslation.set(subtitle.translatedText);
            this.liveLocalSourceText = subtitle.originalText.trim();
            this.liveAiOriginal.set('');
            this.liveAiTranslation.set('');
            this.liveAiPending.set(true);
          } else {
            this.liveAiOriginal.set(subtitle.originalText);
            this.liveAiTranslation.set(subtitle.translatedText);
            this.liveAiPending.set(false);
          }

          this.addSubtitleToHistory(
            subtitle
          );
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
    fullText: string
  ): void {

    if (
      !this.joined() ||
      !this.remoteLanguage()
    ) {
      return;
    }

    const words =
      this.splitWords(fullText);

    /*
     * Sherpa can revise the current hypothesis.
     * Already committed words belong to older subtitle chunks;
     * only the uncommitted tail is allowed to change on screen.
     */
    if (words.length < this.consumedWords) {
      return;
    }

    this.cancelTranslationTimer();

    let remaining =
      words.slice(this.consumedWords);

    /*
     * Commit every complete 5-word chunk.
     *
     * Before commit, the exact same text is already visible through
     * liveSttText + liveLocalTranslation.
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

      /*
       * Show/translate the complete chunk immediately.
       * This also catches the case where Sherpa jumped from
       * 3 directly to 5+ words in one partial.
       */
      this.showLiveChunk(chunk);

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
     * 1-4 words are NOT hidden anymore.
     *
     * Example:
     *   "Where"          -> show + ML Kit now
     *   "Where are"      -> replace + ML Kit now
     *   "Where are the"  -> replace + ML Kit now
     *
     * Sherpa is free to correct earlier words because this is one
     * replaceable live hypothesis, not append-only text.
     */
    if (remaining.length > 0) {
      const liveChunk =
        remaining
          .slice(0, this.maxChunkWords)
          .join(' ');

      this.showLiveChunk(
        liveChunk
      );

      /*
       * If the user stops after 1-4 words, commit exactly what is
       * already visible after the short pause. ML Kit has already
       * translated it; this timer is primarily for OpenAI/history.
       */
      this.schedulePauseCommit();
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


  private schedulePauseCommit():
    void {

    this.cancelTranslationTimer();

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

          if (
            remaining.length === 0
          ) {
            return;
          }

          const chunkWords =
            remaining.slice(
              0,
              this.maxChunkWords
            );

          const chunk =
            chunkWords.join(' ');

          this.consumedWords +=
            chunkWords.length;

          /*
           * Local STT + ML Kit were already shown immediately.
           * Pause now commits the chunk to OpenAI + SignalR/history.
           */
          void this.commitChunk(
            chunk,
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
   * Sherpa FINAL can contain a correction or words not seen in the
   * latest partial. Show those words immediately, then commit them.
   */
  private async flushFinalText(
    finalText: string
  ): Promise<void> {

    this.cancelTranslationTimer();

    const words =
      this.splitWords(
        finalText
      );

    if (
      words.length <=
      this.consumedWords
    ) {
      this.resetSherpaSegment();
      return;
    }

    let remaining =
      words.slice(
        this.consumedWords
      );

    while (
      remaining.length > 0
    ) {
      const chunkWords =
        remaining.slice(
          0,
          this.maxChunkWords
        );

      remaining =
        remaining.slice(
          chunkWords.length
        );

      const chunk =
        chunkWords.join(' ');

      this.showLiveChunk(
        chunk
      );

      this.consumedWords +=
        chunkWords.length;

      await this.commitChunk(
        chunk,
        remaining.length === 0
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
  private commitChunk(
    originalText: string,
    isFinal: boolean
  ): Promise<void> {

    const cleanText =
      originalText.trim();

    if (!cleanText) {
      return Promise.resolve();
    }

    /*
     * A FINAL immediately after a pause can contain the same text.
     * Do not start a duplicate OpenAI request.
     */
    if (
      cleanText ===
      this.lastCommittedChunk
    ) {
      return Promise.resolve();
    }

    this.lastCommittedChunk =
      cleanText;

    const job =
      this.translationQueue.then(
        () =>
          this.commitChunkNow(
            cleanText,
            isFinal
          )
      );

    this.translationQueue =
      job.catch(error => {

        console.error(
          '★★★★★ COMMITTED TRANSLATION FAILED ★★★★★',
          error
        );
      });

    return job;
  }


  private async commitChunkNow(
    cleanText: string,
    isFinal: boolean
  ): Promise<void> {

    const targetLanguage =
      this.remoteLanguage();

    if (
      !targetLanguage ||
      !this.joined()
    ) {
      return;
    }

    const segmentId =
      this.createSegmentId();

    /*
     * Ensure that a committed chunk has a local translation too.
     * Usually the rolling ML Kit request has already produced it,
     * but this makes the committed result deterministic.
     */
    let localTranslatedText =
      cleanText;

    try {
      // Do not translate the same text twice. The rolling live ML Kit
      // result is normally already ready by the time this chunk commits.
      if (
        this.liveLocalSourceText === cleanText &&
        this.liveLocalTranslation().trim()
      ) {
        localTranslatedText = this.liveLocalTranslation().trim();
      } else if (
        this.selectedLanguage !==
        targetLanguage &&
        Capacitor.isNativePlatform() &&
        Capacitor.getPlatform() ===
        'android'
      ) {
        const localResult =
          await this.offlineTranslation
            .translate(
              cleanText,
              this.selectedLanguage,
              targetLanguage
            );

        localTranslatedText =
          localResult.translatedText;
      }

      /*
       * Do not overwrite a newer rolling chunk's translation.
       * We only force the local value when the committed text is
       * still the text currently visible.
       */
      if (
        this.liveSttText().trim() ===
        cleanText
      ) {
        this.liveLocalTranslation.set(
          localTranslatedText
        );
      }

    } catch (error) {

      console.error(
        '★★★★★ COMMITTED ML KIT FAILED ★★★★★',
        error
      );
    }

    /*
     * Publish the fast/local pair immediately.
     *
     * Existing SignalR protocol understands this pair already,
     * so the remote side does not have to wait for OpenAI.
     */
    const fastSubtitle:
      SubtitleMessage = {

      segmentId,

      originalText:
        cleanText,

      translatedText:
        localTranslatedText,

      sourceLanguage:
        this.selectedLanguage,

      targetLanguage,

      isFinal: false
    };

    this.subtitle.set(
      fastSubtitle
    );

    try {
      await this.signalR.sendSubtitle(
        this.sessionId.trim(),
        fastSubtitle
      );
    } catch (error) {
      console.error(
        '★★★★★ FAST SUBTITLE SIGNALR FAILED ★★★★★',
        error
      );
    }

    /*
     * FREE mode stops here.
     * PREMIUM mode additionally produces the OpenAI line below.
     */
    if (
      this.translationMode !==
      'premium'
    ) {
      this.addSubtitleToHistory(
        {
          ...fastSubtitle,
          isFinal
        }
      );

      return;
    }

    this.liveAiPending.set(true);

    try {
      const context =
        this.subtitleHistory()
          .slice(-3)
          .map(item => ({
            originalText:
              item.originalText,

            translatedText:
              item.translatedText
          }));

      const result =
        await this.premiumTranslation
          .translate(
            cleanText,
            this.selectedLanguage,
            targetLanguage,
            context
          );

      /*
       * IMPORTANT:
       * We intentionally keep BOTH translations:
       *
       * liveLocalTranslation = ML Kit
       * liveAiTranslation    = OpenAI
       */
      this.liveAiOriginal.set(
        result.correctedOriginalText
      );

      this.liveAiTranslation.set(
        result.translatedText
      );

      const aiSubtitle:
        SubtitleMessage = {

        /*
         * Same segmentId: this is the final AI version of the
         * already delivered fast/local segment.
         */
        segmentId,

        originalText:
          result.correctedOriginalText,

        translatedText:
          result.translatedText,

        sourceLanguage:
          this.selectedLanguage,

        targetLanguage,

        isFinal: true
      };

      this.subtitle.set(
        aiSubtitle
      );

      /*
       * With the CURRENT protocol the remote side receives this as
       * the final version of the same segment. The sender can show
       * ML Kit + OpenAI simultaneously through the live signals.
       */
      await this.signalR.sendSubtitle(
        this.sessionId.trim(),
        aiSubtitle
      );

      this.addSubtitleToHistory(
        aiSubtitle
      );

      this.translationLog(
        'OPENAI_DONE',
        {
          segmentId,
          rawSttText:
            cleanText,
          correctedOriginalText:
            result.correctedOriginalText,
          localTranslatedText,
          aiTranslatedText:
            result.translatedText
        }
      );

    } catch (error) {

      /*
       * OpenAI failure must never remove the already visible
       * Sherpa + ML Kit result.
       */
      console.error(
        '★★★★★ OPENAI TRANSLATION FAILED ★★★★★',
        error
      );

      this.addSubtitleToHistory(
        {
          ...fastSubtitle,
          isFinal
        }
      );

    } finally {

      this.liveAiPending.set(false);
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


  private addSubtitleToHistory(
    subtitle: SubtitleMessage
  ): void {

    /*
     * Protect against accidental duplicate
     * delivery of the same subtitle ID.
     */
    this.subtitleHistory.update(
      history => {

        if (
          history.some(
            item =>
              item.segmentId ===
              subtitle.segmentId
          )
        ) {
          return history;
        }


        return [
          ...history,
          subtitle
        ];
      }
    );
  }


  toggleHistory():
    void {

    this.historyOpen.update(
      open => !open
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

    this.liveSttText.set('');
    this.liveLocalTranslation.set('');
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

    this.lastObservedFinal = '';

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

