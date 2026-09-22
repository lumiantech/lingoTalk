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


  private segmentCounter = 0;

  private activeSegmentId =
    this.createSegmentId();

  private translationTimer:
    ReturnType<typeof setTimeout> | undefined;

  private translationVersion = 0;

  private lastScheduledText = '';

  private lastTranslatedText = '';

  private lastObservedFinal = '';


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
     * Do not translate every 100 ms PCM chunk.
     * Wait briefly for a more stable partial.
     */
    effect(() => {

      const partial =
        this.speech.partialText().trim();

      if (!partial) {
        return;
      }

      if (partial === this.lastScheduledText) {
        return;
      }

      this.lastScheduledText = partial;

      this.scheduleTranslation(
        partial,
        false
      );
    });


    /*
     * Final Sherpa result is translated
     * immediately and closes the segment.
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

      void this.translateAndPublish(
        finalText,
        true
      );
    });
  }


  async languageChanged():
    Promise<void> {

    localStorage.setItem(
      'lingo-language',
      this.selectedLanguage
    );

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


  async connect(): Promise<void> {

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

          this.remoteLanguage.set(null);
        }
      );


    this.signalR
      .onSubtitleReceived(
        subtitle => {

          console.log(
            '★★★★★ SUBTITLE RECEIVED',
            subtitle,
            '★★★★★'
          );

          this.subtitle.set(
            subtitle
          );
        }
      );


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

    this.connected.set(true);
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

    this.joined.set(true);
  }


  private scheduleTranslation(
    text: string,
    isFinal: boolean
  ): void {

    if (
      !this.joined() ||
      !this.remoteLanguage()
    ) {
      return;
    }

    this.cancelTranslationTimer();

    this.translationTimer =
      setTimeout(
        () => {

          void this.translateAndPublish(
            text,
            isFinal
          );
        },
        750
      );
  }


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
     * For now FREE translation is Android
     * ML Kit only.
     *
     * Chrome can receive subtitles, but does
     * not create translations yet.
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

    if (
      !isFinal &&
      cleanText === this.lastTranslatedText
    ) {
      return;
    }


    const version =
      ++this.translationVersion;

    const segmentId =
      this.activeSegmentId;


    try {

      const result =
        await this.offlineTranslation
          .translate(
            cleanText,
            this.selectedLanguage,
            targetLanguage
          );


      /*
       * A newer partial may already have been
       * requested while ML Kit was translating.
       * Ignore the stale result.
       */
      if (
        !isFinal &&
        version !==
          this.translationVersion
      ) {
        return;
      }


      const subtitle:
        SubtitleMessage = {

        segmentId,

        originalText:
          cleanText,

        translatedText:
          result.translatedText,

        sourceLanguage:
          this.selectedLanguage,

        targetLanguage,

        isFinal
      };


      /*
       * Sender sees exactly the same pair
       * that the remote participant receives.
       */
      this.subtitle.set(
        subtitle
      );


      await this.signalR.sendSubtitle(
        this.sessionId.trim(),
        subtitle
      );


      this.lastTranslatedText =
        cleanText;


      if (isFinal) {

        this.finishSegment();
      }

    } catch (error) {

      console.error(
        '★★★★★ ML KIT TRANSLATION FAILED ★★★★★',
        error
      );
    }
  }


  private finishSegment(): void {

    this.translationVersion++;

    this.cancelTranslationTimer();

    this.segmentCounter++;

    this.activeSegmentId =
      this.createSegmentId();

    this.lastScheduledText = '';

    this.lastTranslatedText = '';
  }


  private createSegmentId():
    string {

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


  async send(): Promise<void> {

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


  async startCall():
    Promise<void> {

    if (!this.joined()) {
      return;
    }

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

    this.subtitle.set(null);

    await this.webRtc.endCall();
  }


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
}