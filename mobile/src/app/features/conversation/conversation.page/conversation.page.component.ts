
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

  private readonly maxChunkWords = 6;

  private readonly pauseMs = 650;


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
      this.splitWords(
        fullText
      );


    /*
     * Sherpa may revise its hypothesis.
     *
     * If it temporarily returns fewer
     * words than we have already consumed,
     * do not resend old text.
     */
    if (
      words.length <
      this.consumedWords
    ) {

      this.translationLog(
        'PARTIAL_SHORTER_THAN_CONSUMED',
        {
          text:
            fullText,

          words:
            words.length,

          consumedWords:
            this.consumedWords
        }
      );

      return;
    }


    let remaining =
      words.slice(
        this.consumedWords
      );


    if (
      remaining.length === 0
    ) {
      return;
    }


    /*
     * New speech arrived, therefore the
     * previous pause timer is no longer
     * valid.
     */
    this.cancelTranslationTimer();


    /*
     * Flush as many complete target chunks
     * as are currently available.
     *
     * Usually Sherpa grows gradually:
     *
     * 3 words
     * 5 words -> flush 5
     *
     * But Sherpa can also jump:
     *
     * 3 words
     * 7 words
     *
     * In that case we flush at most 6.
     */
    while (
      remaining.length >=
      this.targetChunkWords
    ) {

      const chunkSize =
        Math.min(
          remaining.length,
          this.maxChunkWords
        );

      const chunkWords =
        remaining.slice(
          0,
          chunkSize
        );

      const chunk =
        chunkWords.join(' ');


      this.translationLog(
        'WORD_LIMIT_FLUSH',
        {
          chunk,

          chunkWords:
            chunkSize,

          availableWords:
            remaining.length,

          consumedBefore:
            this.consumedWords
        }
      );


      /*
       * Mark these words as consumed BEFORE
       * starting the async translation.
       *
       * That prevents a later Sherpa partial
       * from scheduling the same words again.
       */
      this.consumedWords +=
        chunkSize;


      void this.translateAndPublish(
        chunk,
        false
      );


      remaining =
        words.slice(
          this.consumedWords
        );
    }


    /*
     * Anything left here is normally
     * 1-4 words.
     *
     * If the speaker continues, a new
     * partial will cancel this timer.
     *
     * If the speaker pauses, those few
     * words are translated after 650 ms.
     */
    if (
      remaining.length > 0
    ) {

      this.schedulePauseFlush();
    }
  }


  private schedulePauseFlush():
    void {

    this.cancelTranslationTimer();


    this.translationLog(
      'PAUSE_TIMER_STARTED',
      {
        pauseMs:
          this.pauseMs,

        consumedWords:
          this.consumedWords,

        latestPartialText:
          this.latestPartialText
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


          if (
            remaining.length === 0
          ) {
            return;
          }


          /*
           * Hard protection:
           *
           * even if something unusual
           * happened, this timer will never
           * produce more than 6 words.
           */
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

              words:
                chunkWords.length,

              consumedBefore:
                this.consumedWords
            }
          );


          this.consumedWords +=
            chunkWords.length;


          void this.translateAndPublish(
            text,
            false
          );


          /*
           * Normally PAUSE_FLUSH handles
           * 1-4 words.
           *
           * If for some reason more words
           * remain, process the current
           * complete partial again.
           */
          const stillRemaining =
            words.length -
            this.consumedWords;


          if (
            stillRemaining > 0
          ) {

            this.processPartial(
              this.latestPartialText
            );
          }

        },
        this.pauseMs
      );
  }


  /*
   * Flush words that remain when Sherpa
   * closes the current recognition stream.
   */
  private async flushFinalText(
    finalText: string
  ): Promise<void> {

    this.cancelTranslationTimer();


    const words =
      this.splitWords(
        finalText
      );


    /*
     * Everything in FINAL has already been
     * sent through partial chunks.
     */
    if (
      words.length <=
      this.consumedWords
    ) {

      this.translationLog(
        'FINAL_NO_NEW_WORDS',
        {
          finalText,

          finalWords:
            words.length,

          consumedWords:
            this.consumedWords
        }
      );


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

      /*
       * Final text can theoretically contain
       * many words not seen in partials.
       *
       * Never display more than 6 at once.
       */
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

          words:
            chunkWords.length,

          isLast,

          consumedBefore:
            this.consumedWords
        }
      );


      this.consumedWords +=
        chunkWords.length;


      /*
       * Final chunks are deliberately awaited
       * in order, so their history ordering is
       * deterministic.
       */
      await this.translateAndPublish(
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
   * TRANSLATION + SUBTITLE PUBLISH
   * =========================================================
   */


  private async translateAndPublish(
    originalText: string,
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


    /*
     * FREE translation currently runs
     * natively on Android through ML Kit.
     *
     * Chrome receives and displays the
     * finished subtitle pair.
     *
     * Browser speech/translation can be
     * added later.
     */
    if (
      !Capacitor.isNativePlatform() ||
      Capacitor.getPlatform() !==
      'android'
    ) {
      return;
    }


    const cleanText =
      originalText.trim();


    if (!cleanText) {
      return;
    }


    /*
     * Every delivered chunk gets its own ID.
     *
     * We are no longer using one ID for an
     * entire potentially long Sherpa stream.
     */
    const segmentId =
      this.createSegmentId();


    try {

      const translationStartedAt =
        performance.now();


      this.translationLog(
        'MLKIT_START',
        {
          segmentId,

          text:
            cleanText,

          words:
            this.splitWords(
              cleanText
            ).length,

          sourceLanguage:
            this.selectedLanguage,

          targetLanguage,

          isFinal
        }
      );


      let translatedText:
        string;


      /*
       * Do not invoke ML Kit if both people
       * use the same language.
       */
      if (
        this.selectedLanguage ===
        targetLanguage
      ) {

        translatedText =
          cleanText;

      } else {

        const result =
          await this.offlineTranslation
            .translate(
              cleanText,
              this.selectedLanguage,
              targetLanguage
            );


        translatedText =
          result.translatedText;
      }


      const mlKitMs =
        Math.round(
          performance.now() -
          translationStartedAt
        );


      this.translationLog(
        'MLKIT_DONE',
        {
          segmentId,

          originalText:
            cleanText,

          translatedText,

          words:
            this.splitWords(
              cleanText
            ).length,

          mlKitMs,

          isFinal
        }
      );


      const subtitle:
        SubtitleMessage = {

        segmentId,

        originalText:
          cleanText,

        translatedText,

        sourceLanguage:
          this.selectedLanguage,

        targetLanguage,

        isFinal
      };


      /*
       * Sender sees exactly the same original
       * + translation pair as the receiver.
       */
      this.translationLog(
        'LOCAL_SUBTITLE',
        {
          segmentId,

          originalText:
            subtitle.originalText,

          translatedText:
            subtitle.translatedText,

          isFinal
        }
      );


      this.subtitle.set(
        subtitle
      );


      await this.signalR.sendSubtitle(
        this.sessionId.trim(),
        subtitle
      );


      /*
       * Store a completed delivered subtitle
       * in local transcript history.
       */
      this.addSubtitleToHistory(
        subtitle
      );


      this.translationLog(
        'SIGNALR_SENT',
        {
          segmentId,
          isFinal
        }
      );

    } catch (error) {

      console.error(
        '★★★★★ ML KIT TRANSLATION FAILED ★★★★★',
        error
      );
    }
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

