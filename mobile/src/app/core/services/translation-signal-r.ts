import { Injectable } from '@angular/core';
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel
} from '@microsoft/signalr';

export type SubtitleStage = 'local' | 'ai';

export interface SubtitleMessage {
  segmentId: string;
  originalText: string;
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
  stage: SubtitleStage;
  requestAi: boolean;
}

@Injectable({ providedIn: 'root' })
export class TranslationSignalRService {
  private hubConnection?: HubConnection;

  async connect(baseUrl: string): Promise<void> {
    if (
      this.hubConnection?.state === HubConnectionState.Connected ||
      this.hubConnection?.state === HubConnectionState.Connecting
    ) return;

    this.hubConnection = new HubConnectionBuilder()
      .withUrl(`${baseUrl}/hubs/translation`)
      .withAutomaticReconnect()
      .configureLogging(LogLevel.Information)
      .build();

    await this.hubConnection.start();
  }

  async joinSession(sessionId: string, language: string): Promise<void> {
    this.ensureConnected();
    await this.hubConnection!.invoke('JoinSession', sessionId, language);
  }

  async updateLanguage(sessionId: string, language: string): Promise<void> {
    this.ensureConnected();
    await this.hubConnection!.invoke('UpdateLanguage', sessionId, language);
  }

  async leaveSession(sessionId: string): Promise<void> {
    if (this.hubConnection?.state !== HubConnectionState.Connected) return;
    await this.hubConnection.invoke('LeaveSession', sessionId);
  }

  onParticipantLanguageChanged(handler: (language: string) => void): void {
    this.hubConnection?.off('ParticipantLanguageChanged');
    this.hubConnection?.on('ParticipantLanguageChanged', handler);
  }

  onParticipantLeft(handler: () => void): void {
    this.hubConnection?.off('ParticipantLeft');
    this.hubConnection?.on('ParticipantLeft', handler);
  }

  async sendSubtitle(sessionId: string, subtitle: SubtitleMessage): Promise<void> {
    this.ensureConnected();
    await this.hubConnection!.invoke('SendSubtitle', sessionId, subtitle);
  }

  onSubtitleReceived(handler: (subtitle: SubtitleMessage) => void): void {
    this.hubConnection?.off('SubtitleReceived');
    this.hubConnection?.on('SubtitleReceived', handler);
  }

  onAiSubtitleReceived(handler: (subtitle: SubtitleMessage) => void): void {
    this.hubConnection?.off('AiSubtitleReceived');
    this.hubConnection?.on('AiSubtitleReceived', handler);
  }

  async sendText(sessionId: string, text: string): Promise<void> {
    this.ensureConnected();
    await this.hubConnection!.invoke('SendText', sessionId, text);
  }

  onTextReceived(handler: (text: string) => void): void {
    this.hubConnection?.off('TextReceived');
    this.hubConnection?.on('TextReceived', handler);
  }

  async sendWebRtcOffer(sessionId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    this.ensureConnected();
    await this.hubConnection!.invoke('SendWebRtcOffer', sessionId, JSON.stringify(offer));
  }

  async sendWebRtcAnswer(sessionId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    this.ensureConnected();
    await this.hubConnection!.invoke('SendWebRtcAnswer', sessionId, JSON.stringify(answer));
  }

  async sendIceCandidate(sessionId: string, candidate: RTCIceCandidateInit): Promise<void> {
    this.ensureConnected();
    await this.hubConnection!.invoke('SendIceCandidate', sessionId, JSON.stringify(candidate));
  }

  onWebRtcOffer(handler: (offer: RTCSessionDescriptionInit) => void): void {
    this.hubConnection?.off('WebRtcOfferReceived');
    this.hubConnection?.on('WebRtcOfferReceived', (json: string) => handler(JSON.parse(json)));
  }

  onWebRtcAnswer(handler: (answer: RTCSessionDescriptionInit) => void): void {
    this.hubConnection?.off('WebRtcAnswerReceived');
    this.hubConnection?.on('WebRtcAnswerReceived', (json: string) => handler(JSON.parse(json)));
  }

  onIceCandidate(handler: (candidate: RTCIceCandidateInit) => void): void {
    this.hubConnection?.off('IceCandidateReceived');
    this.hubConnection?.on('IceCandidateReceived', (json: string) => handler(JSON.parse(json)));
  }

  async disconnect(): Promise<void> {
    if (!this.hubConnection) return;
    await this.hubConnection.stop();
    this.hubConnection = undefined;
  }

  private ensureConnected(): void {
    if (!this.hubConnection || this.hubConnection.state !== HubConnectionState.Connected)
      throw new Error('SignalR is not connected.');
  }
}
