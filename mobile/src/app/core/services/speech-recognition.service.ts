import {
    Injectable,
    Service,
    signal
} from '@angular/core';

import {
    Capacitor,
    PluginListenerHandle,
    registerPlugin
} from '@capacitor/core';


interface SpeechRecognitionPlugin {

    start(options: {        language: string;    }): Promise<void>;

    stop(): Promise<void>;

    addListener(
        eventName: 'partialResult',
        listener: (
            data: { text: string }
        ) => void
    ): Promise<PluginListenerHandle>;

    addListener(
        eventName: 'finalResult',
        listener: (
            data: { text: string }
        ) => void
    ): Promise<PluginListenerHandle>;

    addListener(
        eventName: 'error',
        listener: (
            data: {
                code?: number;
                message: string;
            }
        ) => void
    ): Promise<PluginListenerHandle>;

    addListener(
        eventName: 'stateChanged',
        listener: (
            data: {
                state: string;
            }
        ) => void
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

    readonly partialText =
        signal('');

    readonly finalText =
        signal('');

    readonly state =
        signal('stopped');

    readonly error =
        signal<string | null>(null);

    private initialized = false;

    private running = false;


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

        this.error.set(null);

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
                this.partialText.set(
                    data.text
                );
            }
        );


        await NativeSpeechRecognition.addListener(
            'finalResult',
            data => {

                this.finalText.set(
                    data.text
                );

                this.partialText.set('');
            }
        );


        await NativeSpeechRecognition.addListener(
            'stateChanged',
            data => {
                this.state.set(data.state);
            }
        );


        await NativeSpeechRecognition.addListener(
            'error',
            data => {
                this.error.set(
                    `${data.code ?? ''} ${data.message}`
                        .trim()
                );
            }
        );


        this.initialized = true;
    }
}