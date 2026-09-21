import { CommonModule } from '@angular/common';
import { Component, effect, ElementRef, inject, OnDestroy, signal, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  IonButton,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonTitle,
  IonToolbar
} from '@ionic/angular';
import { TranslationSignalRService } from '../../../core/services/translation-signal-r';
import { environment } from '../../../../environments/environment';
import { WebRtcService } from '../../../core/services/web-rtc.service';
import { SpeechRecognitionService } from '../../../core/services/speech-recognition.service';




interface ConversationMessage {
  text: string;
  direction: 'sent' | 'received';
}

@Component({
  selector: 'app-conversation',
  standalone: true,
  templateUrl: './conversation.page.component.html',
  styleUrls: ['./conversation.page.component.scss'],
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
    IonList
  ]
})
export class ConversationPageComponent implements OnDestroy {
  @ViewChild('localVideo')
  private localVideo?: ElementRef<HTMLVideoElement>;

  @ViewChild('remoteVideo')
  private remoteVideo?: ElementRef<HTMLVideoElement>;

  constructor() {

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
          '★★★★★ STARTING STT hr-HR ★★★★★'
        );

        void this.speech.start(
          'hr-HR'
        );

      } else {

        console.log(
          '★★★★★ STOPPING STT ★★★★★'
        );

        void this.speech.stop();
      }
    });
  }


  private async ensureWebRtc(): Promise<void> {

    await this.webRtc.createPeerConnection(
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
  private readonly signalR = inject(TranslationSignalRService);

  readonly webRtc = inject(WebRtcService);
  readonly speech = inject(SpeechRecognitionService);

  sessionId = '';
  messageText = '';

  connected = signal(false);
  joined = signal(false);

  messages = signal<ConversationMessage[]>([]);



  async connect(): Promise<void> {

    await this.signalR.connect(
      environment.apiBaseUrl
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

  private registerWebRtcSignaling(): void {

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

        console.log(
          'WEBRTC ANSWER CREATED',
          answer
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

  async joinSession(): Promise<void> {
    const sessionId = this.sessionId.trim();

    if (!sessionId) {
      return;
    }

    if (!this.connected()) {
      await this.connect();
    }

    await this.signalR.joinSession(sessionId);

    this.joined.set(true);
  }

  async send(): Promise<void> {
    const text = this.messageText.trim();

    if (!text || !this.joined()) {
      return;
    }

    await this.signalR.sendText(
      this.sessionId.trim(),
      text
    );

    this.messages.update(messages => [
      ...messages,
      {
        text,
        direction: 'sent'
      }
    ]);

    this.messageText = '';
  }

  async ngOnDestroy(): Promise<void> {
    if (this.joined()) {
      await this.signalR.leaveSession(
        this.sessionId.trim()
      );
    }

    await this.signalR.disconnect();
  }

  async startCall(): Promise<void> {

    if (!this.joined()) {
      return;
    }

    await this.webRtc.createPeerConnection(
      async candidate => {
        await this.signalR.sendIceCandidate(
          this.sessionId.trim(),
          candidate
        );
      },
      true
    );

    const offer =
      await this.webRtc.createOffer();

    await this.signalR.sendWebRtcOffer(
      this.sessionId.trim(),
      offer
    );
  }

  async endCall(): Promise<void> {
    await this.webRtc.endCall();
  }

  private bindVideoStreams(): void {

    const local = this.webRtc.localMediaStream();

    const remote = this.webRtc.remoteMediaStream();

    if (local && this.localVideo) {
      this.localVideo.nativeElement.srcObject = local;
    }

    if (remote && this.remoteVideo) {
      this.remoteVideo.nativeElement.srcObject = remote;
    }
  }
}