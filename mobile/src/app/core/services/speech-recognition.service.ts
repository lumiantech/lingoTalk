import { Injectable, signal } from '@angular/core';
import {
  Capacitor,
  PluginListenerHandle,
  registerPlugin
} from '@capacitor/core';

export type SttEngine =
  | 'google'
  | 'sherpa'
  | 'none';

export interface SpeechResult {
  text: string;
  engine: SttEngine;
  language: string;
  isFinal: boolean;
  utteranceId: number;
}

interface ModelInstallResult {
  installed: boolean;
  required: boolean;
}

interface SpeechRecognitionPlugin {

  prepareOfflineModel():
    Promise<ModelInstallResult>;

  start(options: {
    language: string;
  }): Promise<void>;

  stop(): Promise<void>;

  getCapabilities():
    Promise<Record<string, unknown>>;

  addListener(
    eventName: 'partialResult' | 'finalResult',
    listener: (data: SpeechResult) => void
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: 'error',
    listener: (data: {
      code?: number;
      message: string;
      engine?: SttEngine;
    }) => void
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: 'stateChanged',
    listener: (data: {
      state: string;
      engine?: SttEngine;
    }) => void
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: 'modelInstallProgress',
    listener: (data: {
      progress: number;
    }) => void
  ): Promise<PluginListenerHandle>;
}

const NativeSpeechRecognition =
  registerPlugin<SpeechRecognitionPlugin>(
    'SpeechRecognition'
  );

@Injectable({
  providedIn: 'root'
})
export class SpeechRecognitionService {

  readonly partialText = signal('');
  readonly finalText = signal('');

  readonly partialUtteranceId = signal(0);
  readonly finalUtteranceId = signal(0);

  readonly state = signal('stopped');

  readonly engine =
    signal<SttEngine>('none');

  readonly language =
    signal('hr-HR');

  readonly error =
    signal<string | null>(null);

  readonly modelReady =
    signal(false);

  readonly modelInstalling =
    signal(false);

  readonly modelInstallProgress =
    signal(0);

  private initialized = false;
  private running = false;

  private preparePromise?:
    Promise<boolean>;

  async prepareOfflineModel():
    Promise<boolean> {

    if (!Capacitor.isNativePlatform()) {

      // Chrome/laptop nema Android Sherpa model.
      // Web aplikaciju ne blokiramo.
      this.modelReady.set(true);

      return true;
    }

    if (this.modelReady()) {
      return true;
    }

    if (this.preparePromise) {
      return this.preparePromise;
    }

    await this.initializeListeners();

    this.preparePromise =
      this.prepareOfflineModelInternal();

    try {

      return await this.preparePromise;

    } finally {

      this.preparePromise = undefined;
    }
  }

  private async prepareOfflineModelInternal():
    Promise<boolean> {

    this.error.set(null);

    this.modelInstalling.set(true);
    this.modelInstallProgress.set(0);

    this.state.set('model_installing');

    try {

      console.log(
        '★★★★★ PREPARING OFFLINE STT MODEL ★★★★★'
      );

      const result =
        await NativeSpeechRecognition
          .prepareOfflineModel();

      this.modelReady.set(
        result.installed || !result.required
      );

      if (this.modelReady()) {

        this.modelInstallProgress.set(100);

        this.state.set('model_ready');

        console.log(
          '★★★★★ OFFLINE STT MODEL READY ★★★★★'
        );
      }

      return this.modelReady();

    } catch (error) {

      const message =
        error instanceof Error
          ? error.message
          : String(error);

      this.error.set(message);

      this.modelReady.set(false);

      this.state.set(
        'model_install_failed'
      );

      console.error(
        '★★★★★ OFFLINE STT MODEL INSTALL FAILED ★★★★★',
        error
      );

      return false;

    } finally {

      this.modelInstalling.set(false);
    }
  }

  async start(
    language = 'hr-HR'
  ): Promise<void> {

    if (!Capacitor.isNativePlatform()) {
      return;
    }

    await this.initializeListeners();

    if (this.running) {
      return;
    }

    /*
     * Poziv više ne smije biti prvi trenutak
     * u kojem instaliramo model.
     *
     * Ovo je samo safety check.
     */
    if (!this.modelReady()) {

      const ready =
        await this.prepareOfflineModel();

      if (!ready) {

        this.error.set(
          'Offline speech model is not ready.'
        );

        return;
      }
    }

    this.language.set(language);

    this.error.set(null);
    this.partialText.set('');

    try {

      await NativeSpeechRecognition.start({
        language
      });

      this.running = true;

      this.state.set('listening');

    } catch (error) {

      this.error.set(
        error instanceof Error
          ? error.message
          : String(error)
      );
    }
  }

  async restart(
    language: string
  ): Promise<void> {

    await this.stop();
    await this.start(language);
  }

  async stop(): Promise<void> {

    if (!Capacitor.isNativePlatform()) {
      return;
    }

    if (!this.running) {
      return;
    }

    try {

      await NativeSpeechRecognition.stop();

    } finally {

      this.running = false;

      this.state.set('stopped');
      this.engine.set('none');

      this.partialText.set('');
    }
  }

  private async initializeListeners():
    Promise<void> {

    if (this.initialized) {
      return;
    }

    await NativeSpeechRecognition.addListener(
      'partialResult',
      data => {

        this.partialUtteranceId.set(data.utteranceId ?? 0);
        this.partialText.set(data.text);

        this.engine.set(
          data.engine ?? 'none'
        );

        if (data.language) {
          this.language.set(data.language);
        }
      }
    );

    await NativeSpeechRecognition.addListener(
      'finalResult',
      data => {

        this.finalUtteranceId.set(data.utteranceId ?? 0);
        this.finalText.set(data.text);

        this.partialText.set('');

        this.engine.set(
          data.engine ?? 'none'
        );

        if (data.language) {
          this.language.set(data.language);
        }
      }
    );

    await NativeSpeechRecognition.addListener(
      'stateChanged',
      data => {

        this.state.set(data.state);

        if (data.engine) {
          this.engine.set(data.engine);
        }

        if (data.state === 'model_ready') {

          this.modelReady.set(true);

          this.modelInstallProgress.set(100);
        }
      }
    );

    await NativeSpeechRecognition.addListener(
      'modelInstallProgress',
      data => {

        this.modelInstalling.set(true);

        this.modelInstallProgress.set(
          data.progress
        );

        console.log(
          '★★★★★ OFFLINE MODEL',
          data.progress,
          '% ★★★★★'
        );
      }
    );

    await NativeSpeechRecognition.addListener(
      'error',
      data => {

        this.error.set(
          `${data.engine
              ? `[${data.engine}] `
              : ''
            }${data.code ?? ''
            } ${data.message
            }`.trim()
        );
      }
    );

    this.initialized = true;
  }
}