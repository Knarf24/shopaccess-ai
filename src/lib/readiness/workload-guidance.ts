import { classifyAiWorkload, mentionsLocalWork, normalizeWorkloadText, withoutNegatedAi } from "./ai-workload";

/** Bounded clarification, shared by the transcript and speech; never a suitability verdict. */
export function workloadGuidance(text: string, language: 'en' | 'es'): string | null {

  const workload = classifyAiWorkload(text);

  if (workload === "unspecified_ai") {
    const normalized = normalizeWorkloadText(text);
    const mentionsCloud = /\b(cloud|colab|nube|sagemaker|vertex ai)\b/.test(normalized);
    const mentionsLocal = mentionsLocalWork(normalized);

    if (mentionsCloud && mentionsLocal) {
      return language === "es"
        ? "Para entender su trabajo con IA, ¿ejecutará o entrenará los modelos en el portátil, en la nube o en ambos?"
        : "To understand your AI workload, will you run or train models on the laptop, in the cloud, or both?";
    }

    return language === "es"
      ? "Para comparar opciones de IA necesito aclarar cómo las usará. ¿Ejecutará los modelos en el portátil o usará un servicio en la nube?"
      : "To compare AI options, I need to understand the workload. Will you run the models on the laptop itself or use a cloud service?";
  }

  if (workload === "local_training") {
    return language === "es"
      ? "Para entrenar modelos de IA localmente, necesitamos conocer el modelo, el tamaño del conjunto de datos, el framework y los requisitos de aceleración. También necesitamos especificaciones verificadas de CPU, RAM, GPU y VRAM. Todavía no puedo verificar qué portátil admite este entrenamiento. ¿Qué modelo y conjunto de datos quiere usar?"
      : "For local AI training, we need the model, dataset size, framework, and accelerator requirements, plus verified CPU, RAM, GPU and VRAM specifications. I cannot yet verify which laptop supports this training workload. What model and dataset do you plan to train?";
  }

 const words = withoutNegatedAi(normalizeWorkloadText(text));
 if (!/\b(ai models?|machine learning|inteligencia artificial|modelos? de ia|modelos? de inteligencia artificial)\b/.test(words)) return null;
 const local = mentionsLocalWork(words);
 const cloud = /\b(cloud|nube|colab)\b/.test(words);
 if (!local && !cloud) return language === 'es'
  ? 'Para comparar opciones de IA necesito aclarar cómo las usará. ¿Ejecutará los modelos en el portátil o usará un servicio en la nube?'
  : 'To compare AI options, I need to understand the workload. Will you run the models on the laptop itself or use a cloud service?';
 if (local) return language === 'es'
  ? 'Para evaluar modelos locales necesitamos los requisitos del modelo y datos comprobados de RAM, GPU y VRAM. Las tarjetas muestran RAM y almacenamiento; eso no verifica la capacidad para IA. No puedo verificar todavía qué opción ejecutará su modelo, ni asumir una GPU NVIDIA por el nombre del producto. ¿Qué modelo de IA quiere ejecutar?'
  : 'For local models, we need the model requirements and verified RAM, GPU and VRAM details. The cards show RAM and storage; those alone do not verify AI capability. I cannot yet verify which option will run your model, or assume an NVIDIA GPU from the product name. Which AI model do you want to run?';
 return language === 'es'
  ? 'Para un servicio en la nube, debemos distinguir los requisitos del servicio y los del trabajo que hará en el portátil. No asumiré que necesita una GPU NVIDIA. ¿Qué servicio en la nube quiere usar?'
  : 'For a cloud service, we should distinguish its requirements from the work you will do on the laptop. I will not assume you need an NVIDIA GPU. Which cloud service do you plan to use?';
}
