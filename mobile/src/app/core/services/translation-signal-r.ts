import { Service } from '@angular/core';
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel
} from '@microsoft/signalr';

@Service()
export class TranslationSignalRService {

  private hubConnection?: HubConnection;

  async connect(baseUrl: string): Promise<void> {
    if (
      this.hubConnection?.state === HubConnectionState.Connected ||
      this.hubConnection?.state === HubConnectionState.Connecting
    ) {
      return;
    }

    this.hubConnection = new HubConnectionBuilder()
      .withUrl(`${baseUrl}/hubs/translation`)
      .withAutomaticReconnect()
      .configureLogging(LogLevel.Information)
      .build();

    await this.hubConnection.start();
  }

  async joinSession(sessionId: string): Promise<void> {
    this.ensureConnected();

    await this.hubConnection!.invoke(
      'JoinSession',
      sessionId
    );
  }

  async leaveSession(sessionId: string): Promise<void> {
    if (
      this.hubConnection?.state !==
      HubConnectionState.Connected
    ) {
      return;
    }

    await this.hubConnection.invoke(
      'LeaveSession',
      sessionId
    );
  }

  async sendText(
    sessionId: string,
    text: string
  ): Promise<void> {
    this.ensureConnected();

    await this.hubConnection!.invoke(
      'SendText',
      sessionId,
      text
    );
  }

  onTextReceived(
    handler: (text: string) => void
  ): void {
    this.hubConnection?.off('TextReceived');

    this.hubConnection?.on(
      'TextReceived',
      handler
    );
  }

  // -------------------------
  // WebRTC signaling
  // -------------------------

  async sendWebRtcOffer(
    sessionId: string,
    offer: RTCSessionDescriptionInit
  ): Promise<void> {
    this.ensureConnected();

    await this.hubConnection!.invoke(
      'SendWebRtcOffer',
      sessionId,
      JSON.stringify(offer)
    );
  }

  async sendWebRtcAnswer(
    sessionId: string,
    answer: RTCSessionDescriptionInit
  ): Promise<void> {
    this.ensureConnected();

    await this.hubConnection!.invoke(
      'SendWebRtcAnswer',
      sessionId,
      JSON.stringify(answer)
    );
  }

  async sendIceCandidate(
    sessionId: string,
    candidate: RTCIceCandidateInit
  ): Promise<void> {
    this.ensureConnected();

    await this.hubConnection!.invoke(
      'SendIceCandidate',
      sessionId,
      JSON.stringify(candidate)
    );
  }

  onWebRtcOffer(
    handler: (
      offer: RTCSessionDescriptionInit
    ) => void
  ): void {
    this.hubConnection?.off(
      'WebRtcOfferReceived'
    );

    this.hubConnection?.on(
      'WebRtcOfferReceived',
      (json: string) => {
        handler(JSON.parse(json));
      }
    );
  }

  onWebRtcAnswer(
    handler: (
      answer: RTCSessionDescriptionInit
    ) => void
  ): void {
    this.hubConnection?.off(
      'WebRtcAnswerReceived'
    );

    this.hubConnection?.on(
      'WebRtcAnswerReceived',
      (json: string) => {
        handler(JSON.parse(json));
      }
    );
  }

  onIceCandidate(
    handler: (
      candidate: RTCIceCandidateInit
    ) => void
  ): void {
    this.hubConnection?.off(
      'IceCandidateReceived'
    );

    this.hubConnection?.on(
      'IceCandidateReceived',
      (json: string) => {
        handler(JSON.parse(json));
      }
    );
  }

  async disconnect(): Promise<void> {
    if (!this.hubConnection) {
      return;
    }

    await this.hubConnection.stop();

    this.hubConnection = undefined;
  }

  private ensureConnected(): void {
    if (
      !this.hubConnection ||
      this.hubConnection.state !==
        HubConnectionState.Connected
    ) {
      throw new Error(
        'SignalR is not connected.'
      );
    }
  }
}