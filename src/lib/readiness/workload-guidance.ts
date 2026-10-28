/** Bounded clarification, shared by the transcript and speech; never a suitability verdict. */
export function workloadGuidance(text: string, language: 'en' | 'es'): string | null {
 const words = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
 if (!/\b(ai models?|machine learning|inteligencia artificial|modelos? de ia|modelos? de inteligencia artificial)\b/.test(words)) return null;
 const local = /\b(local(?:ly|mente)?|on (?:the |my )?laptop(?: itself)?|en (?:el |mi )?(?:portatil|equipo))\b/.test(words);
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
