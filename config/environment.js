/**
 * Configuración de entorno dinámico para GastroBot Backend
 * Maneja URLs y configuraciones específicas del ambiente Railway/local
 */

/**
 * Obtiene la URL base pública del backend
 * Utiliza variables de Railway automáticas cuando están disponibles
 */
const getBaseUrl = () => {
  // En Railway, estas variables están disponibles automáticamente
  const railwayStaticUrl = process.env.RAILWAY_STATIC_URL;
  const railwayPublicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  
  // URL personalizada del entorno
  const customBaseUrl = process.env.BASE_URL;
  
  // Puerto del servidor
  const port = process.env.PORT || 3000;
  
  // Prioridad de URLs:
  // 1. URL personalizada (si está definida)
  // 2. Railway Static URL (automática)
  // 3. Railway Public Domain (automática)
  // 4. Localhost para desarrollo
  
  if (customBaseUrl) {
    console.log('🔧 Usando BASE_URL personalizada:', customBaseUrl);
    return customBaseUrl;
  }
  
  if (railwayStaticUrl) {
    console.log('🚄 Usando RAILWAY_STATIC_URL:', railwayStaticUrl);
    return railwayStaticUrl;
  }
  
  if (railwayPublicDomain) {
    const baseUrl = `https://${railwayPublicDomain}`;
    console.log('🚄 Usando RAILWAY_PUBLIC_DOMAIN:', baseUrl);
    return baseUrl;
  }
  
  // Fallback para desarrollo local
  const localUrl = `http://localhost:${port}`;
  console.log('🏠 Usando localhost:', localUrl);
  return localUrl;
};

/**
 * Configuración del entorno
 */
const config = {
  // Environment detection
  isProduction: process.env.NODE_ENV === 'production' || !!process.env.DATABASE_URL,
  isDevelopment: process.env.NODE_ENV === 'development',
  isRailway: !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_STATIC_URL),
  
  // Server configuration
  port: process.env.PORT || 3000,
  baseUrl: getBaseUrl(),
  
  // Database configuration
  database: {
    url: process.env.DATABASE_URL,
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    name: process.env.DB_NAME || 'gastrobot',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'password'
  },
  
  // Feature flags para el backend
  features: {
    emailNotifications: process.env.FEATURE_EMAIL === 'true',
    smsNotifications: process.env.FEATURE_SMS === 'true',
    whatsappIntegration: process.env.FEATURE_WHATSAPP === 'true',
    loyaltyProgram: process.env.FEATURE_LOYALTY === 'true',
    inventory: process.env.FEATURE_INVENTORY === 'true',
    analytics: process.env.FEATURE_ANALYTICS === 'true',
    delivery: process.env.FEATURE_DELIVERY === 'true'
  },
  
  // External service URLs (para integración con dashboard/chatbot)
  services: {
    dashboard: process.env.DASHBOARD_URL,
    chatbot: process.env.CHATBOT_URL || process.env.ORCHESTRATOR_URL
  },

  // Payment module URL for QR codes
  paymentModuleUrl: process.env.PAYMENT_MODULE_URL || 'https://gastrobot-payment.up.railway.app',
  
  // API configuration
  api: {
    version: process.env.API_VERSION || 'v1',
    timeout: parseInt(process.env.API_TIMEOUT) || 30000,
    rateLimit: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
      max: parseInt(process.env.RATE_LIMIT_MAX) || 100
    }
  },
  
  // File upload configuration
  upload: {
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024, // 5MB
    allowedTypes: process.env.ALLOWED_FILE_TYPES?.split(',') || ['image/jpeg', 'image/png', 'image/webp']
  }
};

/**
 * Genera URL completa para recursos estáticos
 * @param {string} path - Ruta del recurso
 * @returns {string} URL completa
 */
const getPublicUrl = (path) => {
  const baseUrl = config.baseUrl;
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  return `${baseUrl}/${cleanPath}`;
};

/**
 * Log de configuración para debugging
 */
const logConfiguration = () => {
  console.group('⚙️  Backend Configuration');
  console.log('🌍 Environment:', process.env.NODE_ENV || 'development');
  console.log('🚄 Railway:', config.isRailway ? 'Yes' : 'No');
  console.log('🔗 Base URL:', config.baseUrl);
  console.log('💾 Database:', config.database.url ? 'Railway/External' : 'Local');
  console.log('🎛️  Features:', Object.entries(config.features).filter(([, enabled]) => enabled).map(([name]) => name));
  console.log('⚡ Port:', config.port);
  console.groupEnd();
};

module.exports = {
  config,
  getBaseUrl,
  getPublicUrl,
  logConfiguration
};