import {
  Component,
  OnInit
} from '@angular/core';

import {
  IonApp,
  IonRouterOutlet
} from '@ionic/angular';

import { SpeechRecognitionService } from './core/services/speech-recognition.service';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  imports: [
    IonApp,
    IonRouterOutlet
  ],
})
export class AppComponent
  implements OnInit {

  constructor(
    private readonly speech:
      SpeechRecognitionService
  ) { }

  async ngOnInit(): Promise<void> {

    console.log(
      '★★★★★ APP START - CHECKING OFFLINE STT MODEL ★★★★★'
    );

    const ready =
      await this.speech
        .prepareOfflineModel();

    console.log(
      '★★★★★ APP START - OFFLINE STT READY:',
      ready,
      '★★★★★'
    );
  }
}