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
    if (this.hubConnection?.state !== HubConnectionState.Connected) {
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
      this.hubConnection.state !== HubConnectionState.Connected
    ) {
      throw new Error('SignalR is not connected.');
    }
  }
}