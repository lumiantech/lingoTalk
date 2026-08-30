import { CommonModule } from '@angular/common';
import { Component, inject, OnDestroy } from '@angular/core';
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
private readonly signalR = inject(TranslationSignalRService);
  sessionId = '';
  messageText = '';

  connected = false;
  joined = false;

  messages: ConversationMessage[] = [];

  async connect(): Promise<void> {
    await this.signalR.connect(environment.apiBaseUrl);

    this.signalR.onTextReceived((text: string) => {
      this.messages.push({
        text,
        direction: 'received'
      });
    });

    this.connected = true;
  }

  async joinSession(): Promise<void> {
    const sessionId = this.sessionId.trim();

    if (!sessionId) {
      return;
    }

    if (!this.connected) {
      await this.connect();
    }

    await this.signalR.joinSession(sessionId);

    this.joined = true;
  }

  async send(): Promise<void> {
    const text = this.messageText.trim();

    if (!text || !this.joined) {
      return;
    }

    await this.signalR.sendText(
      this.sessionId.trim(),
      text
    );

    this.messages.push({
      text,
      direction: 'sent'
    });

    this.messageText = '';
  }

  async ngOnDestroy(): Promise<void> {
    if (this.joined) {
      await this.signalR.leaveSession(
        this.sessionId.trim()
      );
    }

    await this.signalR.disconnect();
  }
}