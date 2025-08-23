// ==============================================
// BACKEND API PARA GASTROBOT - OPTIMIZADO PARA GPT
// server.js
// ==============================================

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const cron = require('node-cron');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

// Importar sistema de validación centralizado
const { 
  verificarSolapamiento, 
  buscarMesasDisponibles,
  buscarHorariosAlternativos 
} = require('./utils/validacion-reservas');

const app = express();
const PORT = process.env.PORT || 3002;

// Middlewares - CORS simplificado para permitir todo (ChatGPT necesita esto)
app.use(cors());

// Log de todas las peticiones para debugging
app.use((req, res, next) => {
  console.log(`📨 ${new Date().toISOString()} - ${req.method} ${req.path} - Origin: ${req.headers.origin || 'Sin origen'}`);
  
  // Headers específicos para ChatGPT
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Max-Age', '86400');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});
app.use(express.json());

// ===== CONFIGURACIÓN ANTI-CACHE PARA GPT =====
// Desactivar ETag globalmente
app.set('etag', false);

// Middleware global para eliminar caches y validación condicional
app.use((req, res, next) => {
  // Eliminar headers de validación condicional del request
  delete req.headers['if-none-match'];
  delete req.headers['if-modified-since'];
  
  // Establecer headers anti-cache en todas las respuestas
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Surrogate-Control': 'no-store',
    'CDN-Cache-Control': 'no-store'
  });
  
  // Eliminar headers de validación que Express podría añadir
  res.removeHeader('ETag');
  res.removeHeader('Last-Modified');
  
  next();
});

// Configuración de base de datos PostgreSQL
// Detectar si estamos en Railway o local
const isProduction = process.env.NODE_ENV === 'production' || process.env.DATABASE_URL;

let pool;
if (process.env.DATABASE_URL) {
  // Configuración para Railway/Producción
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });
  console.log('📦 Usando DATABASE_URL de Railway');
} else {
  // Configuración para desarrollo local
  pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'gastrobot',
    password: process.env.DB_PASSWORD || 'password',
    port: process.env.DB_PORT || 5432,
  });
  console.log('💻 Usando configuración local de base de datos');
}

// ============================================
// ARCHIVO ESPEJO - Sistema de actualización
// ============================================

let archivoEspejo = {
  restaurante: {},
  horarios: {},
  mesas: [],
  reservas: [],
  menu: { categorias: [] },
  politicas: {},
  promociones: [],
  ultima_actualizacion: null,
  edad_segundos: 0
};

// Función para actualizar el Archivo Espejo
async function actualizarArchivoEspejo() {
  try {
    const inicio = Date.now();
    
    // Limpiar cache cuando se actualiza el espejo
    limpiarCacheHorarios();
    
    // Obtener datos del restaurante
    const restauranteQuery = await pool.query('SELECT * FROM restaurante LIMIT 1');
    archivoEspejo.restaurante = restauranteQuery.rows[0] || {};
    
    // Obtener horarios
    const horariosQuery = await pool.query('SELECT * FROM horarios ORDER BY dia_semana');
    const excepcionesQuery = await pool.query('SELECT * FROM excepciones_horario WHERE fecha >= CURRENT_DATE');
    archivoEspejo.horarios = {
      regular: horariosQuery.rows,
      excepciones: excepcionesQuery.rows
    };
    
    // Obtener mesas y su estado actual
    const mesasQuery = await pool.query(`
      SELECT m.*, 
        CASE 
          WHEN r.id IS NOT NULL THEN 'ocupada'
          ELSE 'libre'
        END as estado
      FROM mesas m
      LEFT JOIN reservas r ON m.id = r.mesa_id 
        AND r.fecha = CURRENT_DATE 
        AND r.estado = 'confirmada'
        AND NOW()::TIME BETWEEN r.hora AND (r.hora + COALESCE(r.duracion, 90) * INTERVAL '1 minute')
      ORDER BY m.numero_mesa
    `);
    archivoEspejo.mesas = mesasQuery.rows;
    
    // Obtener reservas del día y futuras (próximos 30 días)
    const reservasQuery = await pool.query(`
      SELECT r.*, c.nombre, c.telefono, c.email 
      FROM reservas r
      JOIN clientes c ON r.cliente_id = c.id
      WHERE r.fecha >= CURRENT_DATE 
        AND r.fecha <= CURRENT_DATE + INTERVAL '30 days'
        AND r.estado IN ('confirmada', 'pendiente')
      ORDER BY r.fecha, r.hora
    `);
    archivoEspejo.reservas = reservasQuery.rows;
    
    // Obtener menú completo
    const categoriasQuery = await pool.query('SELECT * FROM categorias_menu WHERE visible = true ORDER BY orden');
    const platosQuery = await pool.query(`
      SELECT p.*, array_agg(a.nombre) as alergenos
      FROM platos p
      LEFT JOIN platos_alergenos pa ON p.id = pa.plato_id
      LEFT JOIN alergenos a ON pa.alergeno_id = a.id
      GROUP BY p.id
      ORDER BY p.categoria_id, p.orden, p.nombre
    `);
    
    const categorias = categoriasQuery.rows.map(cat => ({
      ...cat,
      platos: platosQuery.rows.filter(plato => plato.categoria_id === cat.id)
    }));
    archivoEspejo.menu = { categorias };
    
    // Obtener políticas
    const politicasQuery = await pool.query('SELECT * FROM politicas LIMIT 1');
    archivoEspejo.politicas = politicasQuery.rows[0] || {};
    
    // Obtener promociones/eventos activos
    const promocionesQuery = await pool.query(`
      SELECT * FROM promociones 
      WHERE fecha_inicio <= CURRENT_DATE 
        AND fecha_fin >= CURRENT_DATE
        AND activo = true
      ORDER BY fecha_inicio
    `);
    archivoEspejo.promociones = promocionesQuery.rows;
    
    // Actualizar marcas de tiempo
    archivoEspejo.ultima_actualizacion = new Date().toISOString();
    archivoEspejo.edad_segundos = 0;
    
    // Asegurar que la carpeta /archivos existe
    const mirrorFolder = path.join(__dirname, 'archivos');
    await fs.mkdir(mirrorFolder, { recursive: true });

    // Guardar el archivo espejo en /archivos/espejo.json
    await fs.writeFile(
      path.join(mirrorFolder, 'espejo.json'),
      JSON.stringify(archivoEspejo, null, 2),
      'utf8'
    );
    
    console.log(`✅ Archivo Espejo actualizado en ${Date.now() - inicio}ms`);
    return true;
    
  } catch (error) {
    console.error('❌ Error actualizando Archivo Espejo:', error);
    return false;
  }
}

// ============================================
// SISTEMA DE SINCRONIZACIÓN DINÁMICA
// ============================================

/**
 * Genera un archivo espejo.json actualizado como fuente única de verdad
 * Optimizado para el GPT personalizado
 */
async function generarEspejo() {
  try {
    const inicio = Date.now();
    console.log('🔄 Generando nuevo archivo espejo.json...');
    
    const espejo = {};
    
    // 1. Información del restaurante
    const restauranteQuery = await pool.query('SELECT * FROM restaurante LIMIT 1');
    espejo.restaurante = {
      nombre: restauranteQuery.rows[0]?.nombre || '',
      telefono: restauranteQuery.rows[0]?.telefono || '',
      email: restauranteQuery.rows[0]?.email || '',
      direccion: restauranteQuery.rows[0]?.direccion || '',
      sitio_web: restauranteQuery.rows[0]?.web || ''
    };
    
    // 2. Horarios
    const horariosQuery = await pool.query('SELECT * FROM horarios ORDER BY dia_semana');
    const excepcionesQuery = await pool.query('SELECT * FROM excepciones_horario WHERE fecha >= CURRENT_DATE');
    espejo.horarios = {
      regular: horariosQuery.rows,
      excepciones: excepcionesQuery.rows
    };
    
    // 3. Mesas y su estado actual
    const mesasQuery = await pool.query(`
      SELECT m.*, 
        CASE 
          WHEN r.id IS NOT NULL THEN 'ocupada'
          ELSE 'libre'
        END as estado
      FROM mesas m
      LEFT JOIN reservas r ON m.id = r.mesa_id 
        AND r.fecha = CURRENT_DATE 
        AND r.estado IN ('confirmada', 'pendiente')
        AND r.hora <= CURRENT_TIME + INTERVAL '30 minutes'
        AND r.hora >= CURRENT_TIME - INTERVAL '90 minutes'
      WHERE m.activa = true
      ORDER BY m.numero_mesa
    `);
    espejo.mesas = mesasQuery.rows;
    
    // 4. Reservas
    const reservasQuery = await pool.query(`
      SELECT r.*, c.nombre, c.telefono, c.email 
      FROM reservas r
      JOIN clientes c ON r.cliente_id = c.id
      WHERE r.fecha >= CURRENT_DATE - INTERVAL '1 day'
        AND r.fecha <= CURRENT_DATE + INTERVAL '7 days'
      ORDER BY r.fecha, r.hora
    `);
    espejo.reservas = reservasQuery.rows;
    
    // 5. Menú completo
    const categoriasQuery = await pool.query('SELECT * FROM categorias_menu WHERE visible = true ORDER BY orden');
    const platosQuery = await pool.query(`
      SELECT p.*, array_agg(a.nombre) as alergenos
      FROM platos p
      LEFT JOIN platos_alergenos pa ON p.id = pa.plato_id
      LEFT JOIN alergenos a ON pa.alergeno_id = a.id
      GROUP BY p.id
      ORDER BY p.categoria_id, p.nombre
    `);
    
    // Estructurar menú por categorías
    espejo.menu = {
      categorias: categoriasQuery.rows.map(categoria => ({
        ...categoria,
        platos: platosQuery.rows
          .filter(plato => plato.categoria_id === categoria.id)
          .map(plato => ({
            ...plato,
            alergenos: plato.alergenos?.filter(a => a !== null) || []
          }))
      }))
    };
    
    // 6. Políticas
    const politicasQuery = await pool.query('SELECT * FROM politicas LIMIT 1');
    espejo.politicas = politicasQuery.rows[0] || {};
    
    // 7. Metadatos
    espejo.ultima_actualizacion = new Date().toISOString();
    espejo.edad_segundos = 0;
    
    // Asegurar que la carpeta /archivos existe
    const mirrorFolder = path.join(__dirname, 'archivos');
    await fs.mkdir(mirrorFolder, { recursive: true });

    // Guardar en archivo espejo.json en /archivos/
    const archivoPath = path.join(mirrorFolder, 'espejo.json');
    await fs.writeFile(archivoPath, JSON.stringify(espejo, null, 2), 'utf8');
    
    const tiempoTotal = Date.now() - inicio;
    console.log(`✅ Archivo espejo.json generado exitosamente en ${tiempoTotal}ms`);
    
    return {
      exito: true,
      archivo: archivoPath,
      tiempo_ms: tiempoTotal,
      tamaño_kb: Math.round((JSON.stringify(espejo).length / 1024) * 100) / 100
    };
    
  } catch (error) {
    console.error('❌ Error generando espejo.json:', error);
    return {
      exito: false,
      error: error.message
    };
  }
}

/**
 * Lee el archivo espejo.json y valida su edad
 * @returns {Object} Datos del espejo con metadatos de validación
 */
async function leerEspejoDesdeArchivo() {
  try {
    const archivoPath = path.join(__dirname, 'archivos', 'espejo.json');
    
    // Verificar si el archivo existe
    try {
      await fs.access(archivoPath);
    } catch (error) {
      console.log('⚠️  Archivo espejo.json no encontrado, generando nuevo...');
      await generarEspejo();
    }
    
    // Leer el archivo
    const contenido = await fs.readFile(archivoPath, 'utf8');
    const datos = JSON.parse(contenido);
    
    // Calcular edad en segundos
    const ahora = new Date();
    const ultimaActualizacion = new Date(datos.ultima_actualizacion);
    const edadSegundos = Math.floor((ahora - ultimaActualizacion) / 1000);
    
    // Actualizar edad_segundos en los datos
    datos.edad_segundos = edadSegundos;
    
    return {
      exito: true,
      datos,
      edad_segundos: edadSegundos,
      archivo_valido: edadSegundos < 30
    };
    
  } catch (error) {
    console.error('❌ Error leyendo espejo.json:', error);
    return {
      exito: false,
      error: error.message,
      edad_segundos: 999999,
      archivo_valido: false
    };
  }
}

// Actualizar edad del espejo cada segundo
setInterval(() => {
  if (archivoEspejo.ultima_actualizacion) {
    const edad = Math.floor((Date.now() - new Date(archivoEspejo.ultima_actualizacion)) / 1000);
    archivoEspejo.edad_segundos = edad;
  }
}, 1000);

// Actualizar Archivo Espejo cada 15 segundos
cron.schedule('*/15 * * * * *', actualizarArchivoEspejo);

// ============================================
// SINCRONIZACIÓN CONTINUA CON ESPEJO.JSON
// ============================================

// Opcional: Regenerar espejo.json cada 15 segundos para sincronización continua
// Esto asegura que el archivo espejo.json siempre esté actualizado sin depender del Dashboard
cron.schedule('*/15 * * * * *', async () => {
  try {
    await generarEspejo();
  } catch (error) {
    console.error('❌ Error en sincronización automática de espejo.json:', error);
  }
});

// ============================================
// MIDDLEWARES DE VALIDACIÓN
// ============================================

// Verificar frescura del Archivo Espejo
const verificarFrescura = async (req, res, next) => {
  if (archivoEspejo.edad_segundos > 30) {
    const actualizado = await actualizarArchivoEspejo();
    if (!actualizado) {
      return res.status(503).json({
        exito: false,
        mensaje: "Ahora mismo no encuentro esa información en el sistema. Por favor, intenta en unos segundos.",
        codigo: "DATOS_NO_FRESCOS"
      });
    }
  }
  next();
};

// Registrar cambios en el historial
async function registrarCambio(tipo, entidad_id, datos_antes, datos_despues, usuario = 'sistema') {
  try {
    await pool.query(
      `INSERT INTO historial_cambios (tipo, entidad_id, datos_antes, datos_despues, usuario, fecha) 
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [tipo, entidad_id, JSON.stringify(datos_antes), JSON.stringify(datos_despues), usuario]
    );
  } catch (error) {
    console.error('Error registrando cambio:', error);
  }
}

// Endpoint de prueba super simple para el GPT
app.get('/api/ping', (req, res) => {
  res.json({
    ok: true,
    mensaje: "Hola desde GastroBot",
    hora: new Date().toISOString()
  });
});

// Endpoint de resumen (versión simplificada del espejo)
app.get('/api/resumen', (req, res) => {
  res.json({
    exito: true,
    restaurante: archivoEspejo.restaurante?.nombre || "Mi Restaurante",
    mesas_disponibles: archivoEspejo.mesas?.filter(m => m.activa && m.estado === 'libre').length || 0,
    reservas_hoy: archivoEspejo.reservas?.filter(r => r.fecha === new Date().toISOString().split('T')[0]).length || 0,
    edad_segundos: archivoEspejo.edad_segundos || 0
  });
});

// ============================================
// ENDPOINTS PARA EL GPT PERSONALIZADO
// ============================================

// 🧪 Endpoint de prueba simple para ChatGPT
app.get('/api/test', (req, res) => {
  console.log('✅ Test endpoint llamado desde:', req.headers.origin || 'Sin origen');
  res.json({
    exito: true,
    mensaje: 'Conexión exitosa con GastroBot',
    timestamp: new Date().toISOString(),
    servidor: 'Railway'
  });
});

// 🧪 Endpoint simplificado del menú para ChatGPT
app.get('/api/menu-simple', async (req, res) => {
  try {
    console.log('📋 Menu simple solicitado');
    const menuQuery = await pool.query(`
      SELECT c.nombre as categoria, p.nombre as plato, p.precio, p.descripcion
      FROM platos p
      JOIN categorias_menu c ON p.categoria_id = c.id
      WHERE p.disponible = true
      ORDER BY c.orden, p.nombre
    `);
    
    res.json({
      exito: true,
      platos: menuQuery.rows
    });
  } catch (error) {
    console.error('Error en menu-simple:', error);
    res.json({
      exito: false,
      mensaje: 'Error al obtener el menú'
    });
  }
});

// 🔧 Endpoint de control manual para regenerar el espejo desde navegador o curl
app.get('/api/forzar-espejo', async (req, res) => {
  try {
    await actualizarArchivoEspejo();
    res.json({ exito: true, mensaje: 'Espejo generado correctamente' });
  } catch (error) {
    res.status(500).json({ exito: false, mensaje: 'Error al generar el espejo', error: error.message });
  }
});

// ENDPOINT PRINCIPAL: Obtener Archivo Espejo completo desde espejo.json
app.get('/api/espejo', async (req, res) => {
  try {
    // Forzar cabeceras anti-cache y status 200 OK
    res.set({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    
    res.removeHeader('ETag');
    res.removeHeader('Last-Modified');
    
    // Leer datos desde espejo.json
    const resultado = await leerEspejoDesdeArchivo();
    
    if (!resultado.exito) {
      return res.status(503).json({
        exito: false,
        mensaje: "Error al acceder a los datos del restaurante",
        codigo: "ARCHIVO_ESPEJO_ERROR"
      });
    }
    
    // Validar edad de los datos
    if (!resultado.archivo_valido) {
      console.log(`⚠️  Datos antiguos detectados (${resultado.edad_segundos}s), regenerando...`);
      
      // Intentar regenerar
      const regeneracion = await generarEspejo();
      if (regeneracion.exito) {
        // Releer los datos actualizados
        const nuevoResultado = await leerEspejoDesdeArchivo();
        if (nuevoResultado.exito) {
          return res.status(200).json({
            exito: true,
            datos: nuevoResultado.datos,
            mensaje: "Datos actualizados del restaurante (regenerados automáticamente)"
          });
        }
      }
      
      // Si falla la regeneración, devolver datos antiguos con advertencia
      return res.status(200).json({
        exito: true,
        datos: resultado.datos,
        mensaje: "Datos del restaurante (pueden estar desactualizados)",
        advertencia: `Datos con ${resultado.edad_segundos} segundos de antigüedad`
      });
    }
    
    // Datos válidos y frescos
    res.status(200).json({
      exito: true,
      datos: resultado.datos,
      mensaje: "Datos actualizados del restaurante"
    });
    
  } catch (error) {
    console.error('❌ Error en /api/espejo:', error);
    res.status(500).json({
      exito: false,
      mensaje: "Error interno del servidor",
      codigo: "ERROR_INTERNO"
    });
  }
});

// ENDPOINT PARA GENERAR ESPEJO MANUALMENTE
app.get('/api/generar-espejo', async (req, res) => {
  try {
    console.log('📞 Solicitud manual para generar espejo.json');
    
    // Forzar cabeceras anti-cache
    res.set({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    
    res.removeHeader('ETag');
    res.removeHeader('Last-Modified');
    
    // Llamar a la función de generación
    const resultado = await generarEspejo();
    
    if (resultado.exito) {
      res.status(200).json({
        exito: true,
        mensaje: "Archivo espejo.json generado correctamente",
        detalles: {
          archivo: 'espejo.json',
          tiempo_ms: resultado.tiempo_ms,
          tamaño_kb: resultado.tamaño_kb
        }
      });
    } else {
      res.status(500).json({
        exito: false,
        mensaje: "Error al generar el archivo espejo.json",
        error: resultado.error
      });
    }
    
  } catch (error) {
    console.error('❌ Error en endpoint /api/generar-espejo:', error);
    res.status(500).json({
      exito: false,
      mensaje: "Error interno del servidor",
      error: error.message
    });
  }
});

// ============================================
// ENDPOINT PÚBLICO PARA GPT - DATOS NORMALIZADOS
// ============================================

/**
 * Normaliza y limpia los datos del archivo espejo para consumo de GPT
 * Elimina nulls, normaliza formatos y unifica valores
 */
function normalizarDatosParaGPT(datos) {
  if (!datos) return {};

  const resultado = {};

  // Normalizar restaurante
  if (datos.restaurante) {
    const resto = datos.restaurante;
    resultado.restaurante = {};
    
    if (resto.nombre && resto.nombre.trim()) {
      resultado.restaurante.nombre = resto.nombre.trim();
    }
    if (resto.telefono && resto.telefono.trim()) {
      resultado.restaurante.telefono = resto.telefono.trim();
    }
    if (resto.email && resto.email.trim()) {
      resultado.restaurante.email = resto.email.trim();
    }
    if (resto.direccion && resto.direccion.trim()) {
      resultado.restaurante.direccion = resto.direccion.trim();
    }
    
    // Normalizar sitio web
    if (resto.web && resto.web.trim()) {
      let web = resto.web.trim();
      if (!web.startsWith('http://') && !web.startsWith('https://')) {
        web = 'https://' + web;
      }
      if (web !== 'https://' && web !== 'http://') {
        resultado.restaurante.sitio_web = web;
      }
    }
    
    // Normalizar redes sociales (solo si tienen valor)
    const redes = {};
    if (resto.facebook && resto.facebook.trim()) {
      redes.facebook = resto.facebook.trim();
    }
    if (resto.instagram && resto.instagram.trim()) {
      redes.instagram = resto.instagram.trim();
    }
    if (resto.twitter && resto.twitter.trim()) {
      redes.twitter = resto.twitter.trim();
    }
    if (Object.keys(redes).length > 0) {
      resultado.restaurante.redes = redes;
    }
  }

  // Normalizar horarios
  if (datos.horarios) {
    resultado.horarios = {};
    
    if (datos.horarios.regular && Array.isArray(datos.horarios.regular)) {
      resultado.horarios.regular = datos.horarios.regular
        .filter(h => h && h.dia_semana !== null && h.dia_semana !== undefined)
        .map(h => ({
          dia_semana: h.dia_semana,
          abierto: Boolean(!h.cerrado),
          ...(h.apertura && { hora_apertura: h.apertura }),
          ...(h.cierre && { hora_cierre: h.cierre })
        }));
    }
    
    if (datos.horarios.excepciones && Array.isArray(datos.horarios.excepciones)) {
      resultado.horarios.excepciones = datos.horarios.excepciones
        .filter(e => e && e.fecha)
        .map(e => ({
          fecha: e.fecha,
          abierto: Boolean(e.abierto),
          ...(e.hora_apertura && { hora_apertura: e.hora_apertura }),
          ...(e.hora_cierre && { hora_cierre: e.hora_cierre }),
          ...(e.motivo && e.motivo.trim() && { motivo: e.motivo.trim() })
        }));
    }
  }

  // Normalizar mesas
  if (datos.mesas && Array.isArray(datos.mesas)) {
    resultado.mesas = datos.mesas
      .filter(m => m && m.id !== null && m.id !== undefined)
      .map(m => {
        const mesa = {
          id: String(m.id),
          nombre: m.nombre || m.numero_mesa || String(m.id),
          capacidad: parseInt(m.capacidad) || 2,
          fumadores: Boolean(m.fumadores)
        };

        // Normalizar ubicación: solo 'sala' o 'terraza'
        let ubicacion = 'sala';
        if (m.zona) {
          const zona = m.zona.toLowerCase().trim();
          if (zona.includes('terraza') || zona.includes('exterior')) {
            ubicacion = 'terraza';
          }
        }
        if (m.ubicacion) {
          const ubi = m.ubicacion.toLowerCase().trim();
          if (ubi.includes('terraza') || ubi.includes('exterior') || ubi.includes('patio')) {
            ubicacion = 'terraza';
          }
        }
        mesa.ubicacion = ubicacion;

        // Normalizar estado
        mesa.estado = (m.estado || 'libre').toLowerCase().trim();

        return mesa;
      });
  }

  // Normalizar reservas
  if (datos.reservas && Array.isArray(datos.reservas)) {
    resultado.reservas = datos.reservas
      .filter(r => r && r.id !== null && r.id !== undefined)
      .map(r => {
        const reserva = {
          codigo: String(r.id),
          mesa_id: String(r.mesa_id),
          personas: parseInt(r.personas) || 1,
          nombre: r.nombre || ''
        };

        // Normalizar fecha
        if (r.fecha) {
          if (typeof r.fecha === 'string') {
            reserva.fecha = r.fecha.split('T')[0]; // YYYY-MM-DD
          } else if (r.fecha instanceof Date) {
            reserva.fecha = r.fecha.toISOString().split('T')[0]; // YYYY-MM-DD
          }
        }

        // Normalizar hora (solo si es válida)
        if (r.hora && typeof r.hora === 'string' && r.hora.trim() && r.hora !== '00:00:00') {
          reserva.hora = r.hora;
        }

        // Campos opcionales
        if (r.telefono && typeof r.telefono === 'string' && r.telefono.trim()) {
          reserva.telefono = r.telefono.trim();
        }
        if (r.email && typeof r.email === 'string' && r.email.trim()) {
          reserva.email = r.email.trim();
        }
        if (r.notas && typeof r.notas === 'string' && r.notas.trim()) {
          reserva.notas = r.notas.trim();
        }

        // Normalizar estado: confirmada → activa
        let estado = (r.estado || 'activa').toLowerCase().trim();
        if (estado === 'confirmada') {
          estado = 'activa';
        }
        reserva.estado = estado;

        return reserva;
      });
  }

  // Normalizar menú
  if (datos.menu && datos.menu.categorias && Array.isArray(datos.menu.categorias)) {
    resultado.menu = {
      categorias: datos.menu.categorias
        .filter(c => c && c.nombre)
        .map(c => {
          const categoria = {
            id: c.id,
            nombre: c.nombre.trim(),
            ...(c.descripcion && c.descripcion.trim() && { descripcion: c.descripcion.trim() })
          };

          if (c.platos && Array.isArray(c.platos)) {
            categoria.platos = c.platos
              .filter(p => p && p.nombre)
              .map(p => {
                const plato = {
                  id: p.id,
                  nombre: p.nombre.trim(),
                  precio: parseFloat(p.precio) || 0,
                  disponible: Boolean(p.disponible !== false)
                };

                if (p.descripcion && p.descripcion.trim()) {
                  plato.descripcion = p.descripcion.trim();
                }

                // Características booleanas
                if (p.vegetariano) plato.vegetariano = true;
                if (p.vegano) plato.vegano = true;
                if (p.sin_gluten) plato.sin_gluten = true;
                if (p.picante) plato.picante = true;
                if (p.recomendado) plato.recomendado = true;

                // Alérgenos: limpiar nulls
                if (p.alergenos && Array.isArray(p.alergenos)) {
                  const alergenosLimpios = p.alergenos.filter(a => a && a.trim && a.trim() !== '');
                  if (alergenosLimpios.length > 0) {
                    plato.alergenos = alergenosLimpios;
                  }
                }

                // URL de imagen (solo si es válida)
                if (p.imagen_url && p.imagen_url.trim() && 
                    !p.imagen_url.startsWith('blob:') && 
                    p.imagen_url !== '') {
                  plato.imagen_url = p.imagen_url.trim();
                }

                return plato;
              });
          }

          return categoria;
        })
    };
  }

  // Normalizar políticas
  if (datos.politicas) {
    const pol = datos.politicas;
    resultado.politicas = {};

    if (pol.cancelacion_horas && !isNaN(pol.cancelacion_horas)) {
      resultado.politicas.antelacion_cancelacion_min = parseInt(pol.cancelacion_horas) * 60;
    }
    if (pol.tiempo_mesa_minutos && !isNaN(pol.tiempo_mesa_minutos)) {
      resultado.politicas.duracion_estandar_min = parseInt(pol.tiempo_mesa_minutos);
    }
    if (pol.fumadores_terraza !== null && pol.fumadores_terraza !== undefined) {
      resultado.politicas.fumadores_terraza = Boolean(pol.fumadores_terraza);
    }
    if (pol.anticipo_requerido !== null && pol.anticipo_requerido !== undefined) {
      resultado.politicas.anticipo_requerido = Boolean(pol.anticipo_requerido);
    }
    if (pol.niños_permitidos !== null && pol.niños_permitidos !== undefined) {
      resultado.politicas.ninos_permitidos = Boolean(pol.niños_permitidos);
    }
    if (pol.mascotas_permitidas !== null && pol.mascotas_permitidas !== undefined) {
      resultado.politicas.mascotas_permitidas = Boolean(pol.mascotas_permitidas);
    }
  }

  // Edad en segundos
  resultado.edad_segundos = datos.edad_segundos || 0;

  return resultado;
}

// ENDPOINT PÚBLICO PARA GPT: Datos normalizados y limpios
app.get('/api/espejo-gpt', (req, res) => {
  try {
    // Forzar cabeceras anti-cache específicas para este endpoint
    res.set({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Surrogate-Control': 'no-store',
      'CDN-Cache-Control': 'no-store'
    });
    
    // Eliminar cualquier header de validación que pudiera existir
    res.removeHeader('ETag');
    res.removeHeader('Last-Modified');
    
    const datosNormalizados = normalizarDatosParaGPT(archivoEspejo);
    
    // Forzar status 200 OK explícitamente
    res.status(200).json({
      exito: true,
      datos: datosNormalizados,
      mensaje: "OK"
    });
    
  } catch (error) {
    console.error('Error en /api/espejo-gpt:', error);
    
    // También en error, forzar headers anti-cache
    res.set({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
    });
    
    res.status(500).json({
      exito: false,
      mensaje: "Error interno del servidor"
    });
  }
});

// ============================================
// FUNCIONES DE VALIDACIÓN DE HORARIOS CON CACHE
// ============================================

// ELIMINADO CACHE: No usar cache para garantizar datos siempre frescos
// Los datos de configuración pueden cambiar en cualquier momento desde el Dashboard

/**
 * Función vacía mantenida por compatibilidad
 */
function limpiarCacheHorarios() {
  // No hacer nada - ya no usamos cache
}

/**
 * Endpoint para forzar limpieza de cache (útil para debugging)
 */
app.post('/api/admin/limpiar-cache', (req, res) => {
  limpiarCacheHorarios();
  res.json({
    exito: true,
    mensaje: 'Cache limpiado correctamente',
    timestamp: new Date().toISOString()
  });
});

/**
 * Obtiene el horario para una fecha específica directamente de la BD
 * @param {string} fecha - Fecha en formato YYYY-MM-DD
 * @returns {Promise<object>} Horario del día
 */
async function obtenerHorarioDia(fecha) {
  try {
    // Buscar excepciones primero
    const excepcionQuery = await pool.query(
      'SELECT * FROM excepciones_horario WHERE fecha = $1',
      [fecha]
    );
    
    if (excepcionQuery.rows.length > 0) {
      return {
        ...excepcionQuery.rows[0],
        es_excepcion: true
      };
    }
    
    // Si no hay excepción, buscar horario regular
    const diaSemana = new Date(fecha).getDay();
    const horarioQuery = await pool.query(
      'SELECT * FROM horarios WHERE dia_semana = $1',
      [diaSemana]
    );
    
    return horarioQuery.rows[0] || { cerrado: true };
    
  } catch (error) {
    console.error('Error obteniendo horario:', error);
    // Fallback al archivo espejo si hay error de BD
    const excepcion = archivoEspejo.horarios?.excepciones?.find(e => 
      e.fecha === fecha
    );
    
    if (excepcion) {
      return { ...excepcion, es_excepcion: true };
    }
    
    const diaSemana = new Date(fecha).getDay();
    const horarioRegular = archivoEspejo.horarios?.regular?.find(h => 
      h.dia_semana === diaSemana
    );
    
    return horarioRegular || { cerrado: true };
  }
}

/**
 * Obtiene la duración de reserva con cache inteligente
 * @returns {Promise<number>} Duración en minutos
 */
async function obtenerDuracionReserva() {
  try {
    console.log('🔍 [DEBUG] Obteniendo duración de reserva...');
    
    // SIEMPRE consultar la base de datos para obtener valores frescos
    const query = await pool.query('SELECT * FROM politicas LIMIT 1');
    
    console.log('📊 [DEBUG] Resultado de consulta políticas:', {
      rowCount: query.rows.length,
      data: query.rows[0] || 'No hay datos'
    });
    
    if (query.rows.length > 0) {
      const politicas = query.rows[0];
      
      // Log de TODOS los campos para debugging
      console.log('📋 [DEBUG] Campos disponibles en políticas:', Object.keys(politicas));
      console.log('🔍 [DEBUG] Valores relacionados con duración:', {
        tiempo_mesa_minutos: politicas.tiempo_mesa_minutos,
        duracion_estandar_min: politicas.duracion_estandar_min,
        duracion_reserva: politicas.duracion_reserva,
        duracion_defecto: politicas.duracion_defecto
      });
      
      // El campo correcto según la estructura de BD es tiempo_mesa_minutos
      const duracion = politicas.tiempo_mesa_minutos || 120;
      
      console.log(`✅ [DEBUG] Duración final seleccionada: ${duracion} minutos`);
      console.log(`📍 [DEBUG] Campo usado: tiempo_mesa_minutos = ${politicas.tiempo_mesa_minutos}`);
      
      return duracion;
    }
    
    // Si no hay políticas, usar valor por defecto
    console.log('⚠️ [DEBUG] No hay políticas en BD, usando duración por defecto: 120 minutos');
    return 120;
    
  } catch (error) {
    console.error('❌ [DEBUG] Error obteniendo duración de reserva:', error);
    // En caso de error, usar valor por defecto
    return 120;
  }
}

/**
 * Valida si una hora está dentro del horario de apertura
 * IMPORTANTE: Siempre usa datos dinámicos de la BD
 * @param {string} fecha - Fecha en formato YYYY-MM-DD
 * @param {string} hora - Hora en formato HH:MM o HH:MM:SS
 * @param {number} duracion - Duración de la reserva en minutos (opcional)
 * @returns {Promise<object>} Resultado de la validación
 */
async function validarHorarioReserva(fecha, hora, duracion = null) {
  console.log(`\n🔍 [VALIDAR-V2] Validando reserva para ${fecha} a las ${hora}`);
  console.log(`📋 [VALIDAR-V2] Duración recibida como parámetro: ${duracion}`);
  
  // SIEMPRE obtener horario fresco de la BD
  const horarioDia = await obtenerHorarioDia(fecha);
  console.log(`🏪 [VALIDAR-V2] Horario del día:`, JSON.stringify(horarioDia, null, 2));
  
  // Si está cerrado ese día
  if (horarioDia.cerrado) {
    console.log(`❌ [VALIDAR-V2] Restaurant cerrado`);
    return {
      valido: false,
      es_valida: false,
      ultima_entrada: null,
      sugerencia: await obtenerProximoDiaDisponible(fecha),
      motivo: horarioDia.motivo || "El restaurante está cerrado este día",
      horario: horarioDia
    };
  }
  
  // CRÍTICO: SIEMPRE obtener duración fresca de las políticas
  if (!duracion) {
    console.log(`⚠️ [VALIDAR-V2] Sin duración especificada, obteniendo de políticas...`);
    duracion = await obtenerDuracionReserva();
  }
  console.log(`📊 [VALIDAR-V2] Duración FINAL a usar: ${duracion} minutos`);
  
  // Normalizar formato de hora (quitar segundos si los tiene)
  hora = hora.substring(0, 5);
  
  // Obtener horarios del restaurante
  const horaAperturaStr = (horarioDia.apertura || horarioDia.hora_apertura || horarioDia.hora_inicio || '13:00').substring(0, 5);
  const horaCierreStr = (horarioDia.cierre || horarioDia.hora_cierre || horarioDia.hora_fin || '00:00').substring(0, 5);
  
  console.log(`   Horario restaurante: ${horaAperturaStr} - ${horaCierreStr}`);
  
  // USAR NUEVA FUNCIÓN OPTIMIZADA: Calcular última hora de entrada
  const calculoUltimaHora = calcularUltimaHoraEntrada(horaAperturaStr, horaCierreStr, duracion);
  
  // Si no hay tiempo suficiente en el día
  if (!calculoUltimaHora.es_valida) {
    console.log(`❌ [VALIDAR-V2] ${calculoUltimaHora.motivo}`);
    return {
      valido: false,
      es_valida: false,
      ultima_entrada: null,
      sugerencia: null,
      motivo: calculoUltimaHora.motivo,
      horario: horarioDia,
      ultima_hora_calculada: null,
      detalles_calculo: calculoUltimaHora.detalles
    };
  }
  
  // USAR NUEVA FUNCIÓN OPTIMIZADA: Validar hora específica
  const validacionHora = validarHoraEspecifica(hora, calculoUltimaHora, horaAperturaStr);
  
  // Crear respuesta unificada
  const respuestaBase = {
    valido: validacionHora.es_valida,
    es_valida: validacionHora.es_valida,
    ultima_entrada: calculoUltimaHora.ultima_entrada,
    ultima_hora_calculada: calculoUltimaHora.ultima_entrada,
    horario: horarioDia,
    motivo: validacionHora.motivo,
    detalles_calculo: calculoUltimaHora.detalles
  };
  
  if (!validacionHora.es_valida) {
    // Hora inválida - proporcionar sugerencia
    console.log(`❌ [VALIDAR-V2] ${validacionHora.motivo}`);
    
    // Mensaje específico según el caso
    let mensajeSugerencia = "";
    if (validacionHora.sugerencia) {
      if (validacionHora.sugerencia === horaAperturaStr) {
        mensajeSugerencia = `Primera hora disponible: ${validacionHora.sugerencia}`;
      } else {
        mensajeSugerencia = `No puedo reservar a ${hora} porque el local cierra a ${horaCierreStr}. La última hora de entrada disponible es ${validacionHora.sugerencia}. ¿Te va bien?`;
      }
    }
    
    return {
      ...respuestaBase,
      sugerencia: validacionHora.sugerencia,
      mensaje_sugerencia: mensajeSugerencia,
      detalles: {
        hora_solicitada: hora,
        hora_apertura: horaAperturaStr,
        hora_cierre: horaCierreStr,
        duracion_reserva: duracion,
        ultima_entrada_valida: calculoUltimaHora.ultima_entrada,
        cruza_medianoche: calculoUltimaHora.detalles.cruza_medianoche
      }
    };
  }
  
  // Hora válida - devolver confirmación
  console.log(`✅ [VALIDAR-V2] Reserva válida para ${hora}`);
  
  const horaFinStr = calculoUltimaHora.detalles.hora_fin;
  return {
    ...respuestaBase,
    mensaje: "Horario válido para reserva",
    sugerencia: null,
    detalles: {
      hora_reserva: hora,
      hora_fin: horaFinStr,
      duracion: duracion,
      ultima_entrada_dia: calculoUltimaHora.ultima_entrada,
      cruza_medianoche: calculoUltimaHora.detalles.cruza_medianoche,
      tiempo_disponible: calculoUltimaHora.detalles.tiempo_disponible
    }
  };
}

/**
 * Convierte minutos a formato HH:MM manejando días cruzados
 */
function formatearMinutosAHora(minutos) {
  // Manejar valores negativos (última hora antes de medianoche del día anterior)
  if (minutos < 0) {
    minutos = 1440 + minutos; // Convertir a hora del día anterior
  }
  
  // Si es más de 24 horas, ajustar al día siguiente
  if (minutos >= 1440) {
    minutos = minutos - 1440;
  }
  
  const horas = Math.floor(minutos / 60);
  const mins = minutos % 60;
  return `${String(horas).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/**
 * Calcula la última hora de entrada válida para reservas
 * Maneja correctamente horarios que cruzan medianoche
 * @param {string} horaApertura - Hora de apertura en formato HH:MM
 * @param {string} horaCierre - Hora de cierre en formato HH:MM  
 * @param {number} duracion - Duración de la reserva en minutos
 * @returns {object} - {ultima_entrada, es_valida, sugerencia, detalles}
 */
function calcularUltimaHoraEntrada(horaApertura, horaCierre, duracion) {
  console.log(`🧮 [CALCULAR] Calculando última hora: ${horaApertura}-${horaCierre}, duración: ${duracion}min`);
  
  // Normalizar entradas
  horaApertura = horaApertura.substring(0, 5);
  horaCierre = horaCierre.substring(0, 5);
  
  // Convertir a minutos
  const [horaAp, minAp] = horaApertura.split(':').map(Number);
  const [horaCi, minCi] = horaCierre.split(':').map(Number);
  
  const minutosApertura = horaAp * 60 + minAp;
  let minutosCierre = horaCi * 60 + minCi;
  
  // Manejar horarios que cruzan medianoche
  const cruzaMedianoche = minutosCierre <= minutosApertura;
  if (cruzaMedianoche) {
    minutosCierre += 1440; // Añadir 24 horas
    console.log(`   🌙 Horario cruza medianoche. Cierre ajustado: ${minutosCierre} min`);
  }
  
  // Calcular tiempo disponible total
  const tiempoDisponible = minutosCierre - minutosApertura;
  console.log(`   📊 Tiempo total disponible: ${tiempoDisponible} min`);
  
  // Verificar si hay suficiente tiempo para una reserva
  if (tiempoDisponible < duracion) {
    console.log(`   ❌ Tiempo insuficiente: necesita ${duracion}min, disponible ${tiempoDisponible}min`);
    return {
      ultima_entrada: null,
      es_valida: false,
      sugerencia: null,
      motivo: `El restaurante no tiene suficiente tiempo de apertura para una reserva de ${duracion} minutos (disponible: ${tiempoDisponible} min)`,
      detalles: {
        apertura: horaApertura,
        cierre: horaCierre,
        duracion_reserva: duracion,
        tiempo_disponible: tiempoDisponible,
        cruza_medianoche: cruzaMedianoche
      }
    };
  }
  
  // Calcular última hora de entrada
  // La reserva debe TERMINAR antes o exactamente al cierre
  const minutosUltimaEntrada = minutosCierre - duracion;
  const horaUltimaEntrada = formatearMinutosAHora(minutosUltimaEntrada);
  
  console.log(`   ✅ Última entrada calculada: ${minutosUltimaEntrada} min (${horaUltimaEntrada})`);
  console.log(`   📋 Reserva terminaría a las: ${formatearMinutosAHora(minutosUltimaEntrada + duracion)}`);
  
  return {
    ultima_entrada: horaUltimaEntrada,
    es_valida: true,
    sugerencia: horaUltimaEntrada,
    motivo: `Última hora de entrada válida: ${horaUltimaEntrada}`,
    detalles: {
      apertura: horaApertura,
      cierre: horaCierre,
      duracion_reserva: duracion,
      tiempo_disponible: tiempoDisponible,
      cruza_medianoche: cruzaMedianoche,
      hora_fin: formatearMinutosAHora(minutosUltimaEntrada + duracion),
      minutos_ultima_entrada: minutosUltimaEntrada,
      minutos_cierre: minutosCierre
    }
  };
}

/**
 * Valida si una hora específica es válida para hacer una reserva
 * @param {string} horaReserva - Hora solicitada en formato HH:MM
 * @param {object} calculoUltimaHora - Resultado de calcularUltimaHoraEntrada()
 * @param {string} horaApertura - Hora de apertura en formato HH:MM
 * @returns {object} - {es_valida, motivo, sugerencia}
 */
function validarHoraEspecifica(horaReserva, calculoUltimaHora, horaApertura) {
  // Si no hay última hora válida, rechazar
  if (!calculoUltimaHora.es_valida) {
    return {
      es_valida: false,
      motivo: calculoUltimaHora.motivo,
      sugerencia: null
    };
  }
  
  horaReserva = horaReserva.substring(0, 5);
  horaApertura = horaApertura.substring(0, 5);
  
  const [horaRes, minRes] = horaReserva.split(':').map(Number);
  const [horaAp, minAp] = horaApertura.split(':').map(Number);
  
  const minutosReserva = horaRes * 60 + minRes;
  const minutosApertura = horaAp * 60 + minAp;
  let minutosReservaAjustados = minutosReserva;
  
  // Ajustar para horarios que cruzan medianoche
  if (calculoUltimaHora.detalles.cruza_medianoche && minutosReserva < minutosApertura) {
    minutosReservaAjustados += 1440;
    console.log(`   🌙 Reserva después de medianoche. Ajustada: ${minutosReservaAjustados} min`);
  }
  
  // Verificar si está antes de la apertura
  if (minutosReservaAjustados < minutosApertura) {
    return {
      es_valida: false,
      motivo: `El restaurante abre a las ${horaApertura}`,
      sugerencia: horaApertura
    };
  }
  
  // Verificar si está después de la última hora válida
  if (minutosReservaAjustados > calculoUltimaHora.detalles.minutos_ultima_entrada) {
    return {
      es_valida: false,
      motivo: `Con una duración de ${calculoUltimaHora.detalles.duracion_reserva} minutos, la última hora de entrada es ${calculoUltimaHora.ultima_entrada}`,
      sugerencia: calculoUltimaHora.ultima_entrada
    };
  }
  
  // Hora válida
  return {
    es_valida: true,
    motivo: "Horario válido para reserva",
    sugerencia: null
  };
}

/**
 * Obtiene el próximo día disponible después de una fecha
 */
async function obtenerProximoDiaDisponible(fechaInicio) {
  const fecha = new Date(fechaInicio);
  
  for (let i = 1; i <= 7; i++) {
    fecha.setDate(fecha.getDate() + 1);
    const fechaStr = fecha.toISOString().split('T')[0];
    const horario = await obtenerHorarioDia(fechaStr);
    
    if (!horario.cerrado) {
      const horaApertura = (horario.apertura || horario.hora_apertura || horario.hora_inicio).substring(0, 5);
      return {
        fecha: fechaStr,
        hora: horaApertura,
        mensaje: `El próximo día disponible es ${fechaStr} a partir de las ${horaApertura}`
      };
    }
  }
  
  return null;
}

// Consultar horario específico
app.get('/api/consultar-horario', verificarFrescura, async (req, res) => {
  const { fecha } = req.query;
  
  if (!fecha) {
    return res.json({
      exito: false,
      mensaje: "Se requiere una fecha"
    });
  }
  
  try {
    const horario = await obtenerHorarioDia(fecha);
    
    res.json({
      exito: true,
      horario: horario,
      es_excepcion: horario.es_excepcion || false,
      mensaje: horario.cerrado ? 
        `Cerrado el ${fecha}${horario.motivo ? ': ' + horario.motivo : ''}` : 
        `Abierto de ${(horario.apertura || horario.hora_apertura || '').substring(0,5)} a ${(horario.cierre || horario.hora_cierre || '').substring(0,5)}`
    });
  } catch (error) {
    console.error('Error consultando horario:', error);
    res.status(500).json({
      exito: false,
      mensaje: "Error al consultar el horario"
    });
  }
});

// ENDPOINT DE DEBUG PARA DIAGNÓSTICO
app.get('/api/debug/configuracion', async (req, res) => {
  try {
    console.log('\n🔬 [DEBUG-ENDPOINT] Iniciando diagnóstico de configuración...');
    
    // 1. Obtener políticas directamente
    const politicasQuery = await pool.query('SELECT * FROM politicas');
    console.log('📊 [DEBUG-ENDPOINT] Políticas en BD:', politicasQuery.rows);
    
    // 2. Obtener horarios
    const horariosQuery = await pool.query('SELECT * FROM horarios ORDER BY dia_semana');
    console.log('🕒 [DEBUG-ENDPOINT] Horarios en BD:', horariosQuery.rows);
    
    // 3. Probar función obtenerDuracionReserva
    const duracionFunc = await obtenerDuracionReserva();
    console.log('⚙️ [DEBUG-ENDPOINT] Resultado obtenerDuracionReserva():', duracionFunc);
    
    // 4. Probar horario de mañana
    const mañana = new Date();
    mañana.setDate(mañana.getDate() + 1);
    const fechaMañana = mañana.toISOString().split('T')[0];
    
    const horarioMañana = await obtenerHorarioDia(fechaMañana);
    console.log('📅 [DEBUG-ENDPOINT] Horario de mañana:', horarioMañana);
    
    // 5. Simular cálculo de última hora
    if (!horarioMañana.cerrado && politicasQuery.rows.length > 0) {
      const politicas = politicasQuery.rows[0];
      const duracion = politicas.tiempo_mesa_minutos || 120;
      
      const cierreStr = horarioMañana.cierre || horarioMañana.hora_cierre || '00:00';
      const [horaCierre, minCierre] = cierreStr.substring(0,5).split(':').map(Number);
      let minutosCierre = horaCierre * 60 + minCierre;
      
      // Ajustar para horarios después de medianoche
      if (minutosCierre <= 360) { // Si cierre es antes de las 6 AM, está en el día siguiente
        minutosCierre += 1440;
      }
      
      const minutosUltimaEntrada = minutosCierre - duracion;
      const horasUltima = Math.floor(minutosUltimaEntrada / 60);
      const minsUltima = minutosUltimaEntrada % 60;
      const ultimaHora = `${String(horasUltima % 24).padStart(2,'0')}:${String(minsUltima).padStart(2,'0')}`;
      
      console.log('🧮 [DEBUG-ENDPOINT] Cálculo manual última hora:', {
        cierre: cierreStr,
        minutosCierre,
        duracion,
        minutosUltimaEntrada,
        ultimaHora
      });
    }
    
    res.json({
      exito: true,
      debug: {
        timestamp: new Date().toISOString(),
        politicas: politicasQuery.rows,
        horarios: horariosQuery.rows,
        duracion_funcion: duracionFunc,
        horario_mañana: horarioMañana,
        fecha_prueba: fechaMañana
      }
    });
    
  } catch (error) {
    console.error('❌ [DEBUG-ENDPOINT] Error:', error);
    res.status(500).json({
      exito: false,
      error: error.message
    });
  }
});

// Validar horario para reserva (NUEVO ENDPOINT)
app.post('/api/validar-horario-reserva', async (req, res) => {
  const { fecha, hora, duracion } = req.body;
  
  if (!fecha || !hora) {
    return res.status(400).json({
      exito: false,
      valido: false,
      es_valida: false,
      ultima_entrada: null,
      sugerencia: null,
      mensaje: "Se requiere fecha y hora"
    });
  }
  
  try {
    const validacion = await validarHorarioReserva(fecha, hora, duracion);
    console.log(`\n📊 [ENDPOINT] Respuesta validación:`, JSON.stringify(validacion, null, 2));
    
    // Respuesta unificada que siempre incluye los campos esperados
    const respuesta = {
      exito: true,
      valido: validacion.valido || validacion.es_valida,
      es_valida: validacion.es_valida || validacion.valido,
      ultima_entrada: validacion.ultima_entrada || validacion.ultima_hora_calculada,
      ultima_hora_calculada: validacion.ultima_hora_calculada || validacion.ultima_entrada,
      sugerencia: validacion.sugerencia,
      mensaje: validacion.mensaje || validacion.motivo,
      motivo: validacion.motivo,
      horario: validacion.horario,
      detalles: validacion.detalles || {
        apertura: (validacion.horario?.apertura || validacion.horario?.hora_apertura || '').substring(0,5),
        cierre: (validacion.horario?.cierre || validacion.horario?.hora_cierre || '').substring(0,5),
        duracion_reserva: duracion || await obtenerDuracionReserva(),
        cruza_medianoche: validacion.detalles_calculo?.cruza_medianoche || false
      }
    };
    
    // Añadir mensaje de sugerencia si existe
    if (validacion.mensaje_sugerencia) {
      respuesta.mensaje_sugerencia = validacion.mensaje_sugerencia;
    }
    
    // Añadir alternativa si hay sugerencia de hora
    if (validacion.sugerencia && typeof validacion.sugerencia === 'string') {
      respuesta.alternativa = {
        fecha: fecha,
        hora: validacion.sugerencia,
        mensaje: validacion.mensaje_sugerencia || `Hora sugerida: ${validacion.sugerencia}`
      };
    } else if (validacion.sugerencia && typeof validacion.sugerencia === 'object') {
      respuesta.alternativa = validacion.sugerencia;
    }
    
    res.json(respuesta);
    
  } catch (error) {
    console.error('Error validando horario:', error);
    res.status(500).json({
      exito: false,
      valido: false,
      es_valida: false,
      ultima_entrada: null,
      sugerencia: null,
      mensaje: "Error al validar el horario"
    });
  }
});

// Obtener horarios disponibles para una fecha (NUEVO ENDPOINT)
app.get('/api/horarios-disponibles', verificarFrescura, async (req, res) => {
  const { fecha, personas = 2 } = req.query;
  
  if (!fecha) {
    return res.status(400).json({
      exito: false,
      mensaje: "Se requiere una fecha"
    });
  }
  
  try {
    const horarioDia = await obtenerHorarioDia(fecha);
    
    if (horarioDia.cerrado) {
      const proximoDia = await obtenerProximoDiaDisponible(fecha);
      return res.json({
        exito: false,
        mensaje: `El restaurante está cerrado el ${fecha}`,
        cerrado: true,
        proximo_dia_disponible: proximoDia
      });
    }
    
    // Generar slots de tiempo disponibles cada 30 minutos
    const aperturaStr = (horarioDia.apertura || horarioDia.hora_apertura || '13:00').substring(0, 5);
    const cierreStr = (horarioDia.cierre || horarioDia.hora_cierre || '23:00').substring(0, 5);
    
    const [horaApertura, minApertura] = aperturaStr.split(':').map(Number);
    const [horaCierre, minCierre] = cierreStr.split(':').map(Number);
    const minutosApertura = horaApertura * 60 + minApertura;
    const minutosCierre = horaCierre * 60 + minCierre - 30; // 30 min antes del cierre
    
    const slots = [];
    for (let minutos = minutosApertura; minutos <= minutosCierre; minutos += 30) {
      const hora = formatearHora(minutos);
      
      // Verificar disponibilidad de mesas para cada slot
      const disponibilidad = await pool.query(`
        SELECT COUNT(DISTINCT m.id) as mesas_disponibles
        FROM mesas m
        WHERE m.capacidad >= $1
          AND m.capacidad <= $1 + 2
          AND m.activa = true
          AND NOT EXISTS (
            SELECT 1 FROM reservas r
            WHERE r.mesa_id = m.id
              AND r.fecha = $2
              AND r.estado IN ('confirmada', 'pendiente')
              AND (
                -- Detectar solapamiento: horarios se intersectan
                $3::TIME < (r.hora + COALESCE(r.duracion, 90) * INTERVAL '1 minute')
                AND
                r.hora < ($3::TIME + $4 * INTERVAL '1 minute')
              )
          )
      `, [personas, fecha, hora, duracionFinal]);
      
      if (disponibilidad.rows[0].mesas_disponibles > 0) {
        slots.push({
          hora: hora,
          disponible: true,
          mesas_disponibles: parseInt(disponibilidad.rows[0].mesas_disponibles)
        });
      }
    }
    
    res.json({
      exito: true,
      fecha: fecha,
      horario_restaurante: {
        apertura: aperturaStr,
        cierre: cierreStr
      },
      slots_disponibles: slots,
      total_slots: slots.length,
      mensaje: slots.length > 0 ? 
        `Hay ${slots.length} horarios disponibles para ${personas} personas` : 
        "No hay disponibilidad para esta fecha"
    });
    
  } catch (error) {
    console.error('Error obteniendo horarios disponibles:', error);
    res.status(500).json({
      exito: false,
      mensaje: "Error al obtener horarios disponibles"
    });
  }
});

// Ver menú con filtros opcionales
app.get('/api/ver-menu', verificarFrescura, (req, res) => {
  const { categoria, disponible, vegetariano, alergeno } = req.query;
  let menu = JSON.parse(JSON.stringify(archivoEspejo.menu));
  
  // Filtrar por categoría
  if (categoria) {
    menu.categorias = menu.categorias.filter(c => 
      c.nombre.toLowerCase().includes(categoria.toLowerCase())
    );
  }
  
  // Filtrar platos
  menu.categorias = menu.categorias.map(cat => ({
    ...cat,
    platos: cat.platos.filter(p => {
      if (disponible === 'true' && !p.disponible) return false;
      if (vegetariano === 'true' && !p.vegetariano) return false;
      if (alergeno && p.alergenos?.includes(alergeno)) return false;
      return true;
    })
  }));
  
  res.json({
    exito: true,
    menu,
    total_platos: menu.categorias.reduce((sum, cat) => sum + cat.platos.length, 0)
  });
});

// Buscar mesa disponible (ENDPOINT CLAVE PARA RESERVAS)
app.post('/api/buscar-mesa', async (req, res) => {
  // NO usar valor por defecto hardcodeado - obtener de políticas
  const { fecha, hora, personas, duracion } = req.body;
  
  console.log(`\n🔍 [BUSCAR-MESA] Nueva búsqueda: ${fecha} ${hora} para ${personas} personas`);
  
  // Validación de entrada
  if (!fecha || !hora || !personas) {
    return res.status(400).json({
      exito: false,
      mensaje: "Se requiere fecha, hora y número de personas"
    });
  }
  
  // OBTENER DURACIÓN Y VALIDAR HORARIO ANTES DE BUSCAR MESA
  let duracionFinal;
  try {
    // Si no se proporciona duración, obtenerla de las políticas
    duracionFinal = duracion || await obtenerDuracionReserva();
    const validacionHorario = await validarHorarioReserva(fecha, hora, duracionFinal);
    
    if (!validacionHorario.valido) {
      return res.status(400).json({
        exito: false,
        mensaje: validacionHorario.motivo,
        horario_restaurante: validacionHorario.horario,
        duracion_reserva: duracion,
        sugerencia: validacionHorario.sugerencia,
        alternativa: validacionHorario.sugerencia ? {
          fecha: validacionHorario.sugerencia.fecha || fecha,
          hora: validacionHorario.sugerencia.hora,
          mensaje: validacionHorario.sugerencia.mensaje
        } : null
      });
    }
  } catch (error) {
    console.error('Error validando horario en buscar-mesa:', error);
    return res.status(500).json({
      exito: false,
      mensaje: "Error al validar el horario del restaurante"
    });
  }
  
  try {
    // NUEVO: Usar sistema centralizado de validación
    console.log(`🔍 [BUSCAR-MESA] Usando validación centralizada para ${fecha} ${hora}`);
    
    // Buscar mesas disponibles usando el nuevo sistema
    const mesasDisponibles = await buscarMesasDisponibles(pool, fecha, hora, personas, duracionFinal);
    
    if (mesasDisponibles.length > 0) {
      const mesa = mesasDisponibles[0]; // Tomar la primera mesa disponible
      
      // Log especial si es mesa 3
      if (mesa.id === 3) {
        console.log(`✅ [MESA 3] Asignada correctamente sin conflictos`);
      }
      
      // IMPORTANTE: Actualizar archivo espejo inmediatamente
      console.log(`🔄 [SINCRONIZACIÓN] Actualizando archivo espejo...`);
      actualizarArchivoEspejo().catch(err => 
        console.error('Error actualizando archivo espejo:', err)
      );
      
      res.json({
        exito: true,
        mesa_disponible: mesa,
        mensaje: `Mesa ${mesa.numero_mesa} disponible (capacidad: ${mesa.capacidad} personas, zona: ${mesa.zona || 'principal'})`
      });
    } else {
      // BUSCAR ALTERNATIVAS USANDO SISTEMA CENTRALIZADO
      console.log(`🔍 [ALTERNATIVAS] No hay mesa para ${hora}, buscando alternativas...`);
      
      // Obtener horario del día
      const horarioDia = await obtenerHorarioDia(fecha);
      
      if (horarioDia.cerrado) {
        return res.json({
          exito: false,
          mensaje: `El restaurante está cerrado el ${fecha}`,
          alternativas: [],
          horario_restaurante: horarioDia
        });
      }
      
      // Buscar horarios alternativos usando el sistema centralizado
      const alternativas = await buscarHorariosAlternativos(
        pool, 
        null, // No especificar mesa, buscar cualquiera
        fecha, 
        hora, 
        personas, 
        duracionFinal,
        horarioDia
      );
      
      console.log(`   📊 Encontradas ${alternativas.length} alternativas sin conflictos`);
      
      // Construir mensaje más informativo
      let mensajeRespuesta = `No hay disponibilidad para ${personas} personas el ${fecha} a las ${hora}`;
      mensajeRespuesta += `. Todas las mesas están reservadas en ese horario`;
      
      // Generar sugerencia más detallada
      let sugerenciaTexto = "";
      if (alternativas.length > 0) {
        const primeraAlternativa = alternativas[0];
        sugerenciaTexto = `Te sugiero las ${primeraAlternativa.hora} (${primeraAlternativa.mesas_disponibles} mesa${primeraAlternativa.mesas_disponibles > 1 ? 's' : ''} disponible${primeraAlternativa.mesas_disponibles > 1 ? 's' : ''})`;
        
        if (alternativas.length > 1) {
          const otrasHoras = alternativas.slice(1, 4).map(a => a.hora);
          sugerenciaTexto += `. También hay disponibilidad a las: ${otrasHoras.join(', ')}`;
        }
      } else {
        sugerenciaTexto = "No hay disponibilidad en este día. ¿Te gustaría probar otro día?";
      }
      
      // Formatear alternativas para la respuesta
      const alternativasFormateadas = alternativas.map(a => ({
        hora_alternativa: a.hora,
        mesas_disponibles: a.mesas_disponibles
      }));
      
      res.json({
        exito: false,
        mensaje: mensajeRespuesta,
        alternativas: alternativasFormateadas,
        horario_restaurante: {
          apertura: horarioDia.apertura?.substring(0,5),
          cierre: horarioDia.cierre?.substring(0,5),
          duracion_reserva: duracionFinal
        },
        sugerencia: sugerenciaTexto
      });
    }
  } catch (error) {
    console.error('Error buscando mesa:', error);
    
    // Si es un error de validación de horario, devolver el mensaje específico
    if (error.message && error.message.includes('validación')) {
      return res.status(400).json({
        exito: false,
        mensaje: error.message
      });
    }
    
    // Para otros errores, devolver mensaje genérico
    res.status(500).json({
      exito: false,
      mensaje: "Lo siento, ha ocurrido un problema técnico al buscar disponibilidad. Por favor, inténtalo de nuevo en unos momentos."
    });
  }
});

// Crear reserva (ENDPOINT PRINCIPAL PARA RESERVAS)
app.post('/api/crear-reserva', async (req, res) => {
  const { 
    nombre, 
    telefono, 
    email, 
    fecha, 
    hora, 
    personas, 
    mesa_id, 
    notas, 
    alergias,
    celebracion,
    duracion,  // Sin valor por defecto - se obtiene de políticas
    origen  // Nuevo parámetro para identificar el origen de la reserva
  } = req.body;
  
  // Validación completa
  if (!nombre || !telefono || !fecha || !hora || !personas) {
    return res.status(400).json({
      exito: false,
      mensaje: "Faltan datos obligatorios: nombre, teléfono, fecha, hora y personas"
    });
  }
  
  // OBTENER DURACIÓN Y VALIDAR HORARIO ANTES DE CREAR LA RESERVA
  let duracionFinal;
  try {
    // Si no se proporciona duración, obtenerla de las políticas
    duracionFinal = duracion || await obtenerDuracionReserva();
    const validacionHorario = await validarHorarioReserva(fecha, hora, duracionFinal);
    
    if (!validacionHorario.valido) {
      return res.status(400).json({
        exito: false,
        mensaje: validacionHorario.motivo,
        horario_restaurante: validacionHorario.horario,
        duracion_reserva: duracion,
        sugerencia: validacionHorario.sugerencia,
        alternativa: validacionHorario.sugerencia ? {
          fecha: validacionHorario.sugerencia.fecha || fecha,
          hora: validacionHorario.sugerencia.hora,
          mensaje: validacionHorario.sugerencia.mensaje
        } : null
      });
    }
  } catch (error) {
    console.error('Error validando horario en crear-reserva:', error);
    return res.status(500).json({
      exito: false,
      mensaje: "Error al validar el horario del restaurante"
    });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Si no se proporciona mesa_id, buscar una automáticamente
    let mesaAsignada = mesa_id;
    
    // NUEVO: VALIDAR MESA ESPECÍFICA usando sistema centralizado
    if (mesaAsignada) {
      console.log(`🔍 [CREAR-RESERVA] Validando mesa ${mesaAsignada} con sistema centralizado`);
      
      // Usar el sistema centralizado de validación
      const validacion = await verificarSolapamiento(pool, mesaAsignada, fecha, hora, duracionFinal);
      
      // Log especial para mesa 3
      if (mesaAsignada === 3) {
        console.log(`🎯 [MESA 3 - CREAR-RESERVA] Resultado validación:`, validacion);
      }
      
      if (!validacion.valido) {
        await client.query('ROLLBACK');
        
        // Si hay conflictos, buscar alternativas
        const alternativas = await buscarHorariosAlternativos(
          pool, mesaAsignada, fecha, hora, personas, duracionFinal, 
          await obtenerHorarioDia(fecha)
        );
        
        let mensajeAlternativas = "";
        if (alternativas.length > 0) {
          mensajeAlternativas = ` Horarios disponibles: ${alternativas.slice(0, 3).map(a => a.hora).join(', ')}`;
        }
        
        return res.status(400).json({
          exito: false,
          mensaje: validacion.mensaje + mensajeAlternativas,
          conflictos: validacion.conflictos,
          alternativas: alternativas,
          mesa_id: mesaAsignada,
          es_mesa_3: validacion.es_mesa_3
        });
      }
      
      // Si la validación pasó y es mesa 3, log de éxito
      if (mesaAsignada === 3) {
        console.log(`✅ [MESA 3] Validación exitosa - Sin conflictos detectados`);
      }
    }
    
    // NUEVO: Buscar mesa disponible usando sistema centralizado
    if (!mesaAsignada) {
      console.log(`🔍 [CREAR-RESERVA] Buscando mesa disponible con sistema centralizado`);
      
      const mesasDisponibles = await buscarMesasDisponibles(pool, fecha, hora, personas, duracionFinal);
      
      if (mesasDisponibles.length === 0) {
        await client.query('ROLLBACK');
        
        // Buscar horarios alternativos
        const alternativas = await buscarHorariosAlternativos(
          pool, null, fecha, hora, personas, duracionFinal,
          await obtenerHorarioDia(fecha)
        );
        
        let mensajeAlternativas = "";
        if (alternativas.length > 0) {
          mensajeAlternativas = ` Prueba a las: ${alternativas.slice(0, 3).map(a => a.hora).join(', ')}`;
        }
        
        return res.status(400).json({
          exito: false,
          mensaje: `No hay mesas disponibles para ${personas} personas el ${fecha} a las ${hora}.${mensajeAlternativas}`,
          alternativas: alternativas
        });
      }
      
      // Tomar la primera mesa disponible
      mesaAsignada = mesasDisponibles[0].id;
      
      // Log especial si se asigna mesa 3
      if (mesaAsignada === 3) {
        console.log(`✅ [MESA 3] Asignada automáticamente - Validación pasó correctamente`);
      }
      
      console.log(`✅ Mesa ${mesasDisponibles[0].numero_mesa} asignada automáticamente`);
    }
    
    // Crear o buscar cliente
    let clienteQuery = await client.query(
      'SELECT id FROM clientes WHERE telefono = $1',
      [telefono]
    );
    
    let cliente_id;
    if (clienteQuery.rows.length === 0) {
      let nuevoCliente;
      if (alergias && alergias !== '') {
        nuevoCliente = await client.query(
          'INSERT INTO clientes (nombre, telefono, email, alergias) VALUES ($1, $2, $3, $4::TEXT[]) RETURNING id',
          [nombre, telefono, email, [alergias]]
        );
      } else {
        nuevoCliente = await client.query(
          'INSERT INTO clientes (nombre, telefono, email, alergias) VALUES ($1, $2, $3, NULL) RETURNING id',
          [nombre, telefono, email]
        );
      }
      cliente_id = nuevoCliente.rows[0].id;
    } else {
      cliente_id = clienteQuery.rows[0].id;
      // Actualizar datos del cliente
      if (alergias && alergias !== '') {
        await client.query(
          `UPDATE clientes 
           SET nombre = $1, 
               email = COALESCE($2, email),
               alergias = array_append(COALESCE(alergias, ARRAY[]::TEXT[]), $3::TEXT),
               total_reservas = total_reservas + 1
           WHERE id = $4`,
          [nombre, email, alergias, cliente_id]
        );
      } else {
        await client.query(
          `UPDATE clientes 
           SET nombre = $1, 
               email = COALESCE($2, email),
               total_reservas = total_reservas + 1
           WHERE id = $3`,
          [nombre, email, cliente_id]
        );
      }
    }
    
    // Generar código de reserva único
    const codigoReserva = Math.random().toString(36).substring(2, 10).toUpperCase();
    
    // Validar y establecer origen (dashboard, gpt, admin, web)
    const origenValido = ['dashboard', 'gpt', 'admin', 'web'].includes(origen) ? origen : 'web';
    
    // Crear reserva
    const reservaQuery = await client.query(`
      INSERT INTO reservas (
        codigo_reserva, cliente_id, mesa_id, fecha, hora, personas, 
        notas, notas_alergias, celebracion, duracion, estado, origen, creada_en
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'confirmada', $11, NOW())
      RETURNING *
    `, [codigoReserva, cliente_id, mesaAsignada, fecha, hora, personas, 
        notas, alergias, celebracion, duracionFinal, origenValido]);
    
    const reserva = reservaQuery.rows[0];
    
    // Obtener información de la mesa
    const mesaInfo = await client.query('SELECT * FROM mesas WHERE id = $1', [mesaAsignada]);
    
    // Registrar cambio
    await registrarCambio('crear_reserva', reserva.id, null, reserva, origenValido);
    
    await client.query('COMMIT');
    
    // Actualizar Archivo Espejo inmediatamente
    await actualizarArchivoEspejo();
    await generarEspejo();
    
    res.json({
      exito: true,
      reserva: {
        ...reserva,
        mesa: mesaInfo.rows[0]
      },
      codigo_reserva: codigoReserva,
      mensaje: `¡Reserva confirmada! Mesa ${mesaInfo.rows[0].numero_mesa} para ${personas} personas el ${fecha} a las ${hora}. Código: ${codigoReserva}`,
      // Recordatorio removido - obtener dinámicamente si es necesario
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creando reserva:', error);
    res.status(500).json({
      exito: false,
      mensaje: "Lo siento, ha ocurrido un problema al procesar tu reserva. Por favor, inténtalo de nuevo en unos momentos."
    });
  } finally {
    client.release();
  }
});

// Modificar reserva
app.put('/api/modificar-reserva', async (req, res) => {
  const { codigo_reserva, fecha, hora, personas, notas } = req.body;
  
  if (!codigo_reserva) {
    return res.status(400).json({
      exito: false,
      mensaje: "Se requiere el código de reserva"
    });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Buscar reserva por código
    const reservaActual = await client.query(
      'SELECT * FROM reservas WHERE codigo_reserva = $1 AND estado = $2',
      [codigo_reserva, 'confirmada']
    );
    
    if (reservaActual.rows.length === 0) {
      return res.status(404).json({
        exito: false,
        mensaje: "Reserva no encontrada o ya cancelada"
      });
    }
    
    const reserva = reservaActual.rows[0];
    const cambios = {};
    
    // Si cambia fecha, hora o personas, verificar disponibilidad
    if (fecha || hora || personas) {
      const nuevaFecha = fecha || reserva.fecha;
      const nuevaHora = hora || reserva.hora;
      const nuevasPersonas = personas || reserva.personas;
      
      // VALIDAR HORARIO SI CAMBIA FECHA U HORA
      if (fecha || hora) {
        try {
          // Usar la duración actual de la reserva o la duración por defecto
          const duracionReserva = reserva.duracion || await obtenerDuracionReserva();
          const validacionHorario = await validarHorarioReserva(nuevaFecha, nuevaHora, duracionReserva);
          
          if (!validacionHorario.valido) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              exito: false,
              mensaje: validacionHorario.motivo,
              horario_restaurante: validacionHorario.horario,
              duracion_reserva: duracionReserva,
              sugerencia: validacionHorario.sugerencia,
              alternativa: validacionHorario.sugerencia ? {
                fecha: validacionHorario.sugerencia.fecha || nuevaFecha,
                hora: validacionHorario.sugerencia.hora,
                mensaje: validacionHorario.sugerencia.mensaje
              } : null
            });
          }
        } catch (error) {
          console.error('Error validando horario en modificar-reserva:', error);
          await client.query('ROLLBACK');
          return res.status(500).json({
            exito: false,
            mensaje: "Error al validar el nuevo horario"
          });
        }
      }
      
      // Buscar nueva mesa si es necesario
      // Usar la duración actual de la reserva o la duración por defecto
      const duracionReserva = reserva.duracion || await obtenerDuracionReserva();
      
      const mesaQuery = await client.query(`
        SELECT m.id FROM mesas m
        WHERE m.capacidad >= $1
          AND m.activa = true
          AND NOT EXISTS (
            SELECT 1 FROM reservas r
            WHERE r.mesa_id = m.id
              AND r.estado IN ('confirmada', 'pendiente')
              AND r.id != $4
              AND (
                -- CASO 1: Misma fecha - verificar solapamientos básicos
                r.fecha = $2 
                AND (
                  -- Solapamiento temporal: verificar intersección de horarios
                  $3::TIME < (r.hora + COALESCE(r.duracion, $5) * INTERVAL '1 minute')
                  AND
                  r.hora < ($3::TIME + $5 * INTERVAL '1 minute')
                )
                AND (
                  -- CASO 1A: Para fechas futuras, solo verificar solapamiento básico
                  r.fecha > CURRENT_DATE
                  OR
                  -- CASO 1B: Para HOY, verificar solapamiento + protecciones adicionales
                  (r.fecha = CURRENT_DATE AND (
                    -- Solapamiento básico ya verificado arriba, ahora verificar casos especiales:
                    
                    -- Reserva existente está en curso ahora
                    NOW()::TIME BETWEEN r.hora AND (r.hora + COALESCE(r.duracion, $5) * INTERVAL '1 minute')
                    OR
                    -- Reserva existente empezará pronto (< 15 min)
                    (r.hora <= (NOW()::TIME + INTERVAL '15 minutes') AND r.hora >= NOW()::TIME)
                    OR
                    -- Nueva reserva es muy pronto (< 15 min) y hay solapamiento
                    ($3::TIME <= (NOW()::TIME + INTERVAL '15 minutes'))
                    OR
                    -- Caso normal: simplemente hay solapamiento de horarios
                    true  -- Ya verificado en la condición principal
                  ))
                )
              )
          )
        ORDER BY m.capacidad
        LIMIT 1
      `, [nuevasPersonas, nuevaFecha, nuevaHora, reserva.id, duracionReserva]);
      
      if (mesaQuery.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          exito: false,
          mensaje: "No hay disponibilidad para los nuevos datos"
        });
      }
      
      cambios.mesa_id = mesaQuery.rows[0].id;
    }
    
    // Actualizar reserva
    if (fecha) cambios.fecha = fecha;
    if (hora) cambios.hora = hora;
    if (personas) cambios.personas = personas;
    if (notas) cambios.notas = notas;
    
    const setClauses = Object.keys(cambios).map((key, i) => `${key} = $${i + 2}`);
    
    if (setClauses.length > 0) {
      const updateQuery = `
        UPDATE reservas 
        SET ${setClauses.join(', ')}, modificada_en = NOW()
        WHERE id = $1
        RETURNING *
      `;
      
      const valores = [reserva.id, ...Object.values(cambios)];
      const resultado = await client.query(updateQuery, valores);
      
      await registrarCambio('modificar_reserva', reserva.id, reserva, resultado.rows[0], 'gpt');
      
      await client.query('COMMIT');
      await actualizarArchivoEspejo();
      await generarEspejo();
      
      res.json({
        exito: true,
        reserva: resultado.rows[0],
        mensaje: "Reserva modificada correctamente",
        cambios_realizados: Object.keys(cambios)
      });
    } else {
      res.json({
        exito: false,
        mensaje: "No se proporcionaron cambios para actualizar"
      });
    }
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error modificando reserva:', error);
    res.status(500).json({
      exito: false,
      mensaje: "Error al modificar la reserva"
    });
  } finally {
    client.release();
  }
});

// Cancelar reserva por código
app.delete('/api/cancelar-reserva', verificarFrescura, async (req, res) => {
  const { codigo_reserva, motivo = "Cancelado por cliente" } = req.body;
  
  if (!codigo_reserva) {
    return res.status(400).json({
      exito: false,
      mensaje: "Se requiere el código de reserva"
    });
  }
  
  try {
    // Buscar y actualizar reserva
    const resultado = await pool.query(
      `UPDATE reservas 
       SET estado = 'cancelada', 
           motivo_cancelacion = $1,
           cancelada_por = 'cliente',
           cancelada_en = NOW()
       WHERE codigo_reserva = $2 AND estado = 'confirmada'
       RETURNING *`,
      [motivo, codigo_reserva]
    );
    
    if (resultado.rows.length === 0) {
      return res.status(404).json({
        exito: false,
        mensaje: "Reserva no encontrada o ya cancelada"
      });
    }
    
    const reserva = resultado.rows[0];
    
    // Registrar cambio
    await registrarCambio('cancelar_reserva', reserva.id, 
      { estado: 'confirmada' }, 
      { estado: 'cancelada', motivo }, 
      'gpt'
    );
    
    // Actualizar contador de cancelaciones del cliente
    await pool.query(
      'UPDATE clientes SET total_cancelaciones = total_cancelaciones + 1 WHERE id = $1',
      [reserva.cliente_id]
    );
    
    // Verificar lista de espera
    const listaEspera = await pool.query(`
      SELECT * FROM lista_espera 
      WHERE fecha = $1 
        AND personas <= $2
        AND estado = 'esperando'
      ORDER BY prioridad, creada_en
      LIMIT 1
    `, [reserva.fecha, reserva.personas]);
    
    let notificacionListaEspera = null;
    if (listaEspera.rows.length > 0) {
      // Actualizar estado de lista de espera
      await pool.query(
        `UPDATE lista_espera 
         SET estado = 'notificado', notificado_en = NOW() 
         WHERE id = $1`,
        [listaEspera.rows[0].id]
      );
      notificacionListaEspera = listaEspera.rows[0];
    }
    
    await actualizarArchivoEspejo();
    await generarEspejo();
    
    res.json({
      exito: true,
      mensaje: "Reserva cancelada correctamente",
      codigo_cancelado: codigo_reserva,
      lista_espera_notificada: notificacionListaEspera ? 
        `Se ha notificado a ${notificacionListaEspera.nombre} de la disponibilidad` : null
    });
    
  } catch (error) {
    console.error('Error cancelando reserva:', error);
    res.status(500).json({
      exito: false,
      mensaje: "Error al cancelar la reserva"
    });
  }
});

// Cancelar reserva por ID (cambiar estado a cancelada - desde Dashboard)
app.put('/api/cancelar-reserva/:id', verificarFrescura, async (req, res) => {
  const { id } = req.params;
  const { motivo = "Cancelado desde dashboard" } = req.body;
  
  try {
    // Actualizar el estado de la reserva a cancelada
    const resultado = await pool.query(
      `UPDATE reservas 
       SET estado = 'cancelada', 
           motivo_cancelacion = $1,
           fecha_actualizacion = NOW()
       WHERE id = $2 AND estado != 'cancelada'
       RETURNING *, (SELECT nombre FROM clientes WHERE id = cliente_id) as nombre_cliente`,
      [motivo, id]
    );
    
    if (resultado.rows.length === 0) {
      // Verificar si existe pero ya está cancelada
      const reservaExistente = await pool.query(
        'SELECT estado FROM reservas WHERE id = $1',
        [id]
      );
      
      if (reservaExistente.rows.length === 0) {
        return res.status(404).json({
          exito: false,
          mensaje: "Reserva no encontrada"
        });
      }
      
      if (reservaExistente.rows[0].estado === 'cancelada') {
        return res.status(400).json({
          exito: false,
          mensaje: "La reserva ya está cancelada"
        });
      }
    }
    
    const reservaCancelada = resultado.rows[0];
    
    // Registrar el cambio
    await registrarCambio('cancelar_reserva', id, 
      { estado: 'confirmada' }, 
      { estado: 'cancelada', motivo }, 
      'dashboard'
    );
    
    // Actualizar archivo espejo
    await actualizarArchivoEspejo();
    await generarEspejo();
    
    res.json({
      exito: true,
      mensaje: `Reserva de ${reservaCancelada.nombre_cliente} cancelada correctamente`,
      reserva_cancelada: {
        id: reservaCancelada.id,
        nombre: reservaCancelada.nombre_cliente,
        fecha: reservaCancelada.fecha,
        hora: reservaCancelada.hora,
        estado: reservaCancelada.estado
      }
    });
    
  } catch (error) {
    console.error('Error cancelando reserva:', error);
    res.status(500).json({
      exito: false,
      mensaje: "Error al cancelar la reserva",
      error: error.message
    });
  }
});

// Eliminar reserva por ID (desde Dashboard)
app.delete('/api/cancelar-reserva/:id', verificarFrescura, async (req, res) => {
  const { id } = req.params;
  const { motivo = "Eliminado desde dashboard" } = req.body;
  
  try {
    // Buscar la reserva antes de eliminarla
    const reservaExistente = await pool.query(
      `SELECT r.*, c.nombre, c.telefono, m.numero_mesa 
       FROM reservas r
       JOIN clientes c ON r.cliente_id = c.id
       JOIN mesas m ON r.mesa_id = m.id
       WHERE r.id = $1`,
      [id]
    );
    
    if (reservaExistente.rows.length === 0) {
      return res.status(404).json({
        exito: false,
        mensaje: "Reserva no encontrada"
      });
    }
    
    const reserva = reservaExistente.rows[0];
    
    // Eliminar la reserva completamente
    await pool.query('DELETE FROM reservas WHERE id = $1', [id]);
    
    // Registrar el cambio
    await registrarCambio('eliminar_reserva', id, 
      { estado: reserva.estado, nombre: reserva.nombre }, 
      { estado: 'eliminada', motivo }, 
      'dashboard'
    );
    
    // Actualizar archivo espejo
    await actualizarArchivoEspejo();
    await generarEspejo();
    
    res.json({
      exito: true,
      mensaje: `Reserva de ${reserva.nombre} eliminada correctamente`,
      reserva_eliminada: {
        id: reserva.id,
        nombre: reserva.nombre,
        fecha: reserva.fecha,
        hora: reserva.hora,
        mesa: reserva.numero_mesa
      }
    });
    
  } catch (error) {
    console.error('Error eliminando reserva:', error);
    res.status(500).json({
      exito: false,
      mensaje: "Error al eliminar la reserva"
    });
  }
});

// Añadir a lista de espera
app.post('/api/lista-espera', verificarFrescura, async (req, res) => {
  const { nombre, telefono, email, fecha, hora_preferida, personas, flexible = false, notas } = req.body;
  
  if (!nombre || !telefono || !fecha || !personas) {
    return res.status(400).json({
      exito: false,
      mensaje: "Se requiere nombre, teléfono, fecha y número de personas"
    });
  }
  
  try {
    const prioridad = flexible ? 1 : 2;
    
    const resultado = await pool.query(`
      INSERT INTO lista_espera (
        nombre, telefono, email, fecha, hora_preferida, personas, 
        flexible, notas, prioridad, estado, creada_en
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'esperando', NOW())
      RETURNING *
    `, [nombre, telefono, email, fecha, hora_preferida, personas, flexible, notas, prioridad]);
    
    res.json({
      exito: true,
      lista_espera: resultado.rows[0],
      mensaje: `Añadido a lista de espera para ${personas} personas el ${fecha}`,
      posicion: await obtenerPosicionListaEspera(resultado.rows[0].id, fecha)
    });
    
  } catch (error) {
    console.error('Error añadiendo a lista de espera:', error);
    res.status(500).json({
      exito: false,
      mensaje: "Error al añadir a lista de espera"
    });
  }
});

// Función auxiliar para obtener posición en lista de espera
async function obtenerPosicionListaEspera(id, fecha) {
  const resultado = await pool.query(`
    SELECT COUNT(*) + 1 as posicion
    FROM lista_espera
    WHERE fecha = $1 
      AND estado = 'esperando'
      AND id < $2
  `, [fecha, id]);
  
  return resultado.rows[0].posicion;
}

// Ver políticas del restaurante
app.get('/api/ver-politicas', verificarFrescura, (req, res) => {
  res.json({
    exito: true,
    politicas: archivoEspejo.politicas,
    mensaje: "Políticas del restaurante"
  });
});

// Ver promociones activas
app.get('/api/ver-promociones', verificarFrescura, (req, res) => {
  res.json({
    exito: true,
    promociones: archivoEspejo.promociones,
    total: archivoEspejo.promociones.length,
    mensaje: archivoEspejo.promociones.length > 0 ? 
      "Promociones activas" : "No hay promociones activas actualmente"
  });
});

// Consultar reserva específica
app.get('/api/consultar-reserva', verificarFrescura, async (req, res) => {
  const { codigo_reserva, telefono } = req.query;
  
  if (!codigo_reserva && !telefono) {
    return res.status(400).json({
      exito: false,
      mensaje: "Se requiere código de reserva o teléfono"
    });
  }
  
  try {
    let query;
    let params;
    
    if (codigo_reserva) {
      query = `
        SELECT r.*, c.nombre, c.telefono, c.email, m.numero_mesa, m.zona
        FROM reservas r
        JOIN clientes c ON r.cliente_id = c.id
        JOIN mesas m ON r.mesa_id = m.id
        WHERE r.codigo_reserva = $1 AND r.estado IN ('confirmada', 'pendiente')
      `;
      params = [codigo_reserva];
    } else {
      query = `
        SELECT r.*, c.nombre, c.telefono, c.email, m.numero_mesa, m.zona
        FROM reservas r
        JOIN clientes c ON r.cliente_id = c.id
        JOIN mesas m ON r.mesa_id = m.id
        WHERE c.telefono = $1 
          AND r.fecha >= CURRENT_DATE
          AND r.estado IN ('confirmada', 'pendiente')
        ORDER BY r.fecha, r.hora
      `;
      params = [telefono];
    }
    
    const resultado = await pool.query(query, params);
    
    if (resultado.rows.length === 0) {
      return res.json({
        exito: false,
        mensaje: "No se encontraron reservas activas"
      });
    }
    
    res.json({
      exito: true,
      reservas: resultado.rows,
      total: resultado.rows.length,
      mensaje: `Encontrada(s) ${resultado.rows.length} reserva(s)`
    });
    
  } catch (error) {
    console.error('Error consultando reserva:', error);
    res.status(500).json({
      exito: false,
      mensaje: "Error al consultar reserva"
    });
  }
});

// ============================================
// ENDPOINTS - DASHBOARD ADMIN
// ============================================

// Estado del sistema
app.get('/api/admin/estado-sistema', async (req, res) => {
  try {
    // Estadísticas del día
    const estadisticasHoy = await pool.query(`
      SELECT 
        COUNT(CASE WHEN estado = 'confirmada' THEN 1 END) as reservas_confirmadas,
        COUNT(CASE WHEN estado = 'cancelada' THEN 1 END) as reservas_canceladas,
        COUNT(CASE WHEN estado = 'no_show' THEN 1 END) as no_shows,
        SUM(CASE WHEN estado = 'confirmada' THEN personas ELSE 0 END) as personas_esperadas
      FROM reservas
      WHERE fecha = CURRENT_DATE
    `);
    
    // Mesas ocupadas ahora
    const mesasOcupadas = await pool.query(`
      SELECT COUNT(DISTINCT mesa_id) as ocupadas
      FROM reservas
      WHERE fecha = CURRENT_DATE
        AND estado = 'confirmada'
        AND NOW()::TIME BETWEEN hora AND (hora + duracion * INTERVAL '1 minute')
    `);
    
    // Total de mesas
    const totalMesas = await pool.query('SELECT COUNT(*) as total FROM mesas WHERE activa = true');
    
    // Próximas reservas
    const proximasReservas = await pool.query(`
      SELECT r.*, c.nombre, c.telefono, m.numero_mesa
      FROM reservas r
      JOIN clientes c ON r.cliente_id = c.id
      JOIN mesas m ON r.mesa_id = m.id
      WHERE r.fecha = CURRENT_DATE
        AND r.hora > NOW()::TIME
        AND r.estado = 'confirmada'
      ORDER BY r.hora
      LIMIT 5
    `);
    
    const estadisticas = {
      espejo: {
        ultima_actualizacion: archivoEspejo.ultima_actualizacion,
        edad_segundos: archivoEspejo.edad_segundos,
        estado: archivoEspejo.edad_segundos <= 30 ? 'fresco' : 'obsoleto'
      },
      hoy: estadisticasHoy.rows[0],
      mesas_ocupadas: parseInt(mesasOcupadas.rows[0].ocupadas),
      mesas_totales: parseInt(totalMesas.rows[0].total),
      ocupacion_porcentaje: Math.round((mesasOcupadas.rows[0].ocupadas / totalMesas.rows[0].total) * 100),
      proximas_reservas: proximasReservas.rows
    };
    
    res.json({
      exito: true,
      estadisticas
    });
  } catch (error) {
    console.error('Error obteniendo estado del sistema:', error);
    res.status(500).json({
      exito: false,
      mensaje: "Error al obtener estado del sistema"
    });
  }
});

// Todas las reservas con filtros
app.get('/api/admin/reservas', async (req, res) => {
  const { fecha, estado, mesa_id, limite = 50 } = req.query;
  
  try {
    let query = `
      SELECT r.*, c.nombre, c.telefono, c.email, m.numero_mesa, m.zona
      FROM reservas r
      JOIN clientes c ON r.cliente_id = c.id
      JOIN mesas m ON r.mesa_id = m.id
      WHERE 1=1
    `;
    
    const params = [];
    let paramCount = 1;
    
    if (fecha) {
      query += ` AND r.fecha = $${paramCount}`;
      params.push(fecha);
      paramCount++;
    } else {
      query += ` AND r.fecha >= CURRENT_DATE`;
    }
    
    if (estado) {
      query += ` AND r.estado = $${paramCount}`;
      params.push(estado);
      paramCount++;
    }
    
    if (mesa_id) {
      query += ` AND r.mesa_id = $${paramCount}`;
      params.push(mesa_id);
      paramCount++;
    }
    
    query += ` ORDER BY r.fecha, r.hora LIMIT $${paramCount}`;
    params.push(limite);
    
    const resultado = await pool.query(query, params);
    
    res.json({
      exito: true,
      reservas: resultado.rows,
      total: resultado.rows.length
    });
  } catch (error) {
    console.error('Error obteniendo reservas:', error);
    res.status(500).json({
      exito: false,
      mensaje: "Error al obtener reservas"
    });
  }
});

// Gestión de mesas
app.get('/api/admin/mesas', async (req, res) => {
  try {
    const mesas = await pool.query(`
      SELECT m.*,
        COUNT(r.id) as reservas_hoy,
        CASE 
          WHEN EXISTS (
            SELECT 1 FROM reservas r2
            WHERE r2.mesa_id = m.id
              AND r2.fecha = CURRENT_DATE
              AND r2.estado = 'confirmada'
              AND NOW()::TIME BETWEEN r2.hora AND (r2.hora + r2.duracion * INTERVAL '1 minute')
          ) THEN 'ocupada'
          ELSE 'libre'
        END as estado_actual
      FROM mesas m
      LEFT JOIN reservas r ON m.id = r.mesa_id 
        AND r.fecha = CURRENT_DATE 
        AND r.estado = 'confirmada'
      GROUP BY m.id
      ORDER BY m.numero_mesa
    `);
    
    res.json({
      exito: true,
      mesas: mesas.rows
    });
  } catch (error) {
    res.status(500).json({ exito: false, mensaje: "Error al obtener mesas" });
  }
});

app.post('/api/admin/mesas', async (req, res) => {
  const { numero_mesa, nombre, capacidad, zona, ubicacion, unible } = req.body;
  
  // Validación de entrada
  if (!numero_mesa || !capacidad) {
    return res.status(400).json({
      exito: false,
      mensaje: "Número de mesa y capacidad son obligatorios"
    });
  }
  
  try {
    // Verificar que no exista una mesa con el mismo número
    const mesaExistente = await pool.query(
      'SELECT id FROM mesas WHERE numero_mesa = $1',
      [numero_mesa]
    );
    
    if (mesaExistente.rows.length > 0) {
      return res.status(400).json({
        exito: false,
        mensaje: `Ya existe una mesa con el número ${numero_mesa}`
      });
    }
    
    const resultado = await pool.query(
      `INSERT INTO mesas (numero_mesa, nombre, capacidad, zona, ubicacion, unible, activa) 
       VALUES ($1, $2, $3, $4, $5, $6, true) 
       RETURNING *`,
      [numero_mesa, nombre || null, capacidad, zona || null, ubicacion || null, unible || false]
    );
    
    await registrarCambio('crear_mesa', resultado.rows[0].id, null, resultado.rows[0], 'admin');
    await actualizarArchivoEspejo();
    await generarEspejo();
    
    res.json({
      exito: true,
      mesa: resultado.rows[0],
      mensaje: `Mesa ${numero_mesa} creada correctamente`
    });
  } catch (error) {
    console.error('Error creando mesa:', error);
    if (error.code === '23505') { // Unique violation
      res.status(400).json({ 
        exito: false, 
        mensaje: `Ya existe una mesa con el número ${numero_mesa}` 
      });
    } else {
      res.status(500).json({ 
        exito: false, 
        mensaje: "Error al crear mesa" 
      });
    }
  }
});

app.put('/api/admin/mesas/:id', async (req, res) => {
  const { id } = req.params;
  const { numero_mesa, nombre, capacidad, zona, ubicacion, activa } = req.body;
  
  try {
    // Obtener datos anteriores para el historial
    const mesaAnterior = await pool.query('SELECT * FROM mesas WHERE id = $1', [id]);
    
    const resultado = await pool.query(
      `UPDATE mesas 
       SET numero_mesa = COALESCE($1, numero_mesa), nombre = $2, capacidad = COALESCE($3, capacidad), zona = $4, ubicacion = $5, activa = COALESCE($6, activa)
       WHERE id = $7
       RETURNING *`,
      [numero_mesa, nombre, capacidad, zona, ubicacion, activa, id]
    );
    
    if (resultado.rows.length === 0) {
      return res.status(404).json({ exito: false, mensaje: "Mesa no encontrada" });
    }
    
    await registrarCambio('actualizar_mesa', id, mesaAnterior.rows[0], resultado.rows[0], 'admin');
    await actualizarArchivoEspejo();
    await generarEspejo();
    
    res.json({
      exito: true,
      mesa: resultado.rows[0],
      mensaje: "Mesa actualizada correctamente"
    });
  } catch (error) {
    console.error('Error actualizando mesa:', error);
    res.status(500).json({ exito: false, mensaje: "Error al actualizar mesa" });
  }
});

app.delete('/api/admin/mesas/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    // Verificar si la mesa tiene reservas futuras
    const reservasFuturas = await pool.query(
      `SELECT COUNT(*) as total FROM reservas 
       WHERE mesa_id = $1 AND fecha >= CURRENT_DATE AND estado IN ('confirmada', 'pendiente')`,
      [id]
    );
    
    if (parseInt(reservasFuturas.rows[0].total) > 0) {
      return res.status(400).json({
        exito: false,
        mensaje: `No se puede eliminar la mesa. Tiene ${reservasFuturas.rows[0].total} reservas futuras`
      });
    }
    
    // Obtener datos de la mesa antes de eliminar
    const mesaAnterior = await pool.query('SELECT * FROM mesas WHERE id = $1', [id]);
    
    if (mesaAnterior.rows.length === 0) {
      return res.status(404).json({ exito: false, mensaje: "Mesa no encontrada" });
    }
    
    // Eliminar la mesa
    await pool.query('DELETE FROM mesas WHERE id = $1', [id]);
    
    await registrarCambio('eliminar_mesa', id, mesaAnterior.rows[0], null, 'admin');
    await actualizarArchivoEspejo();
    await generarEspejo();
    
    res.json({
      exito: true,
      mensaje: `Mesa ${mesaAnterior.rows[0].numero_mesa} eliminada correctamente`
    });
  } catch (error) {
    console.error('Error eliminando mesa:', error);
    res.status(500).json({ exito: false, mensaje: "Error al eliminar mesa" });
  }
});

// Gestión del menú
app.get('/api/admin/menu', async (req, res) => {
  try {
    const categorias = await pool.query('SELECT * FROM categorias_menu ORDER BY orden');
    const platos = await pool.query(`
      SELECT p.*, array_agg(a.nombre) as alergenos
      FROM platos p
      LEFT JOIN platos_alergenos pa ON p.id = pa.plato_id
      LEFT JOIN alergenos a ON pa.alergeno_id = a.id
      GROUP BY p.id
      ORDER BY p.categoria_id, p.orden, p.nombre
    `);
    
    const menu = categorias.rows.map(cat => ({
      ...cat,
      platos: platos.rows.filter(p => p.categoria_id === cat.id)
    }));
    
    res.json({
      exito: true,
      menu
    });
  } catch (error) {
    res.status(500).json({ exito: false, mensaje: "Error al obtener menú" });
  }
});

app.post('/api/admin/menu/categoria', async (req, res) => {
  const { nombre, descripcion, orden } = req.body;
  
  try {
    const resultado = await pool.query(
      'INSERT INTO categorias_menu (nombre, descripcion, orden, visible) VALUES ($1, $2, $3, true) RETURNING *',
      [nombre, descripcion, orden || 0]
    );
    
    await actualizarArchivoEspejo();
    await generarEspejo();
    res.json({ exito: true, categoria: resultado.rows[0] });
  } catch (error) {
    res.status(500).json({ exito: false, mensaje: "Error al crear categoría" });
  }
});

app.post('/api/admin/menu/plato', async (req, res) => {
  const { 
    categoria_id, nombre, descripcion, precio, imagen_url,
    vegetariano, vegano, sin_gluten, picante, recomendado,
    alergenos, disponible 
  } = req.body;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Convertir tipos de datos para compatibilidad con la BD
    const picanteValue = picante === true ? 1 : (picante === false ? 0 : (picante || 0));
    
    const platoQuery = await client.query(
      `INSERT INTO platos (
        categoria_id, nombre, descripcion, precio, imagen_url,
        vegetariano, vegano, sin_gluten, picante, recomendado, disponible,
        creado_en, actualizado_en
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW()) RETURNING *`,
      [categoria_id, nombre, descripcion, precio, imagen_url,
       vegetariano || false, vegano || false, sin_gluten || false, 
       picanteValue, recomendado || false, disponible !== false]
    );
    
    const plato = platoQuery.rows[0];
    
    // Asociar alérgenos si se proporcionan (filtrar null/empty)
    if (Array.isArray(alergenos) && alergenos.length > 0) {
      for (const alergenoNombre of alergenos) {
        // Validar que el nombre no sea null/empty/undefined
        if (!alergenoNombre || typeof alergenoNombre !== 'string' || alergenoNombre.trim() === '') {
          console.warn('Skipping invalid allergen:', alergenoNombre);
          continue;
        }
        
        const nombreLimpio = alergenoNombre.trim();
        
        // Buscar o crear alérgeno
        let alergeno = await client.query('SELECT id FROM alergenos WHERE nombre = $1', [nombreLimpio]);
        
        if (alergeno.rows.length === 0) {
          alergeno = await client.query(
            'INSERT INTO alergenos (nombre) VALUES ($1) RETURNING id',
            [nombreLimpio]
          );
        }
        
        // Asociar alérgeno con plato
        await client.query(
          'INSERT INTO platos_alergenos (plato_id, alergeno_id) VALUES ($1, $2)',
          [plato.id, alergeno.rows[0].id]
        );
      }
    }
    
    // Intentar registrar cambio (opcional)
    try {
      await registrarCambio('crear_plato', plato.id, null, plato, 'admin');
    } catch (registroError) {
      console.warn('Warning: No se pudo registrar el cambio en el historial:', registroError.message);
    }
    
    await client.query('COMMIT');
    await actualizarArchivoEspejo();
    await generarEspejo();
    
    res.json({ 
      exito: true, 
      plato,
      mensaje: `Plato "${nombre}" creado correctamente`
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creando plato:', error);
    res.status(500).json({ exito: false, mensaje: "Error al crear plato" });
  } finally {
    client.release();
  }
});

// Actualizar plato completo
app.put('/api/admin/menu/plato/:id', async (req, res) => {
  const { id } = req.params;
  const { 
    categoria_id, nombre, descripcion, precio, imagen_url,
    vegetariano, vegano, sin_gluten, picante, recomendado, 
    disponible, alergenos 
  } = req.body;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Obtener datos anteriores para el historial
    const platoAnterior = await client.query('SELECT * FROM platos WHERE id = $1', [id]);
    
    if (platoAnterior.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ exito: false, mensaje: "Plato no encontrado" });
    }
    
    // Convertir tipos de datos para compatibilidad con la BD
    const picanteValue = picante === true ? 1 : (picante === false ? 0 : picante);
    
    // Actualizar plato
    const platoActualizado = await client.query(`
      UPDATE platos 
      SET 
        categoria_id = COALESCE($1, categoria_id),
        nombre = COALESCE($2, nombre),
        descripcion = COALESCE($3, descripcion),
        precio = COALESCE($4, precio),
        imagen_url = COALESCE($5, imagen_url),
        vegetariano = COALESCE($6, vegetariano),
        vegano = COALESCE($7, vegano),
        sin_gluten = COALESCE($8, sin_gluten),
        picante = COALESCE($9, picante),
        recomendado = COALESCE($10, recomendado),
        disponible = COALESCE($11, disponible),
        actualizado_en = NOW()
      WHERE id = $12
      RETURNING *
    `, [categoria_id, nombre, descripcion, precio, imagen_url, 
        vegetariano, vegano, sin_gluten, picanteValue, recomendado, disponible, id]);
    
    // Actualizar alérgenos si se proporcionan
    if (alergenos !== undefined) {
      // Eliminar alérgenos existentes
      await client.query('DELETE FROM platos_alergenos WHERE plato_id = $1', [id]);
      
      // Añadir nuevos alérgenos (filtrar null/empty)
      if (Array.isArray(alergenos) && alergenos.length > 0) {
        for (const alergenoNombre of alergenos) {
          // Validar que el nombre no sea null/empty/undefined
          if (!alergenoNombre || typeof alergenoNombre !== 'string' || alergenoNombre.trim() === '') {
            console.warn('Skipping invalid allergen:', alergenoNombre);
            continue;
          }
          
          const nombreLimpio = alergenoNombre.trim();
          
          // Buscar o crear alérgeno
          let alergeno = await client.query('SELECT id FROM alergenos WHERE nombre = $1', [nombreLimpio]);
          
          if (alergeno.rows.length === 0) {
            alergeno = await client.query(
              'INSERT INTO alergenos (nombre) VALUES ($1) RETURNING id',
              [nombreLimpio]
            );
          }
          
          // Asociar alérgeno con plato
          await client.query(
            'INSERT INTO platos_alergenos (plato_id, alergeno_id) VALUES ($1, $2)',
            [id, alergeno.rows[0].id]
          );
        }
      }
    }
    
    // Intentar registrar cambio (opcional)
    try {
      await registrarCambio('actualizar_plato', id, platoAnterior.rows[0], platoActualizado.rows[0], 'admin');
    } catch (registroError) {
      console.warn('Warning: No se pudo registrar el cambio en el historial:', registroError.message);
    }
    
    await client.query('COMMIT');
    await actualizarArchivoEspejo();
    await generarEspejo();
    
    res.json({ 
      exito: true, 
      plato: platoActualizado.rows[0],
      mensaje: "Plato actualizado correctamente" 
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error actualizando plato:', error);
    res.status(500).json({ exito: false, mensaje: "Error al actualizar plato" });
  } finally {
    client.release();
  }
});

// Eliminar plato
app.delete('/api/admin/menu/plato/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    // Obtener datos del plato antes de eliminar
    const platoAnterior = await pool.query('SELECT * FROM platos WHERE id = $1', [id]);
    
    if (platoAnterior.rows.length === 0) {
      return res.status(404).json({ exito: false, mensaje: "Plato no encontrado" });
    }
    
    // Eliminar relaciones con alérgenos
    await pool.query('DELETE FROM platos_alergenos WHERE plato_id = $1', [id]);
    
    // Eliminar el plato
    await pool.query('DELETE FROM platos WHERE id = $1', [id]);
    
    // Intentar registrar cambio (opcional)
    try {
      await registrarCambio('eliminar_plato', id, platoAnterior.rows[0], null, 'admin');
    } catch (registroError) {
      console.warn('Warning: No se pudo registrar el cambio en el historial:', registroError.message);
    }
    
    await actualizarArchivoEspejo();
    await generarEspejo();
    
    res.json({
      exito: true,
      mensaje: `Plato "${platoAnterior.rows[0].nombre}" eliminado correctamente`
    });
    
  } catch (error) {
    console.error('Error eliminando plato:', error);
    res.status(500).json({ exito: false, mensaje: "Error al eliminar plato" });
  }
});

// Actualizar disponibilidad de plato
app.put('/api/admin/menu/plato/:id/disponibilidad', async (req, res) => {
  const { id } = req.params;
  const { disponible } = req.body;
  
  try {
    const resultado = await pool.query(
      'UPDATE platos SET disponible = $1, actualizado_en = NOW() WHERE id = $2 RETURNING *',
      [disponible, id]
    );
    
    if (resultado.rows.length === 0) {
      return res.status(404).json({ exito: false, mensaje: "Plato no encontrado" });
    }
    
    await actualizarArchivoEspejo();
    await generarEspejo();
    res.json({ 
      exito: true, 
      plato: resultado.rows[0],
      mensaje: `Plato marcado como ${disponible ? 'disponible' : 'no disponible'}` 
    });
  } catch (error) {
    console.error('Error actualizando disponibilidad:', error);
    res.status(500).json({ exito: false, mensaje: "Error al actualizar disponibilidad" });
  }
});

// Subir imagen de plato (simple, guardando URL)
app.post('/api/admin/menu/plato/imagen', async (req, res) => {
  // Por ahora, implementamos un endpoint simple que recibe una URL
  // En el futuro se puede extender para manejar archivos con multer
  const { imagen_url } = req.body;
  
  if (!imagen_url) {
    return res.status(400).json({
      exito: false,
      mensaje: "Se requiere una URL de imagen"
    });
  }
  
  try {
    // Validar que la URL sea válida
    new URL(imagen_url);
    
    res.json({
      exito: true,
      imagen_url: imagen_url,
      mensaje: "URL de imagen procesada correctamente"
    });
  } catch (error) {
    res.status(400).json({
      exito: false,
      mensaje: "URL de imagen no válida"
    });
  }
});

// Gestión de políticas
app.get('/api/admin/politicas', async (req, res) => {
  try {
    const politicas = await pool.query('SELECT * FROM politicas LIMIT 1');
    res.json({
      exito: true,
      politicas: politicas.rows[0] || {}
    });
  } catch (error) {
    res.status(500).json({ exito: false, mensaje: "Error al obtener políticas" });
  }
});

app.put('/api/admin/politicas', async (req, res) => {
  const politicas = req.body;
  
  try {
    // Limpiar cache de políticas antes de la actualización
    limpiarCacheHorarios();
    
    const existe = await pool.query('SELECT id FROM politicas LIMIT 1');
    
    if (existe.rows.length > 0) {
      // Actualizar
      const campos = Object.keys(politicas).filter(k => k !== 'id');
      const valores = campos.map(k => politicas[k]);
      const setClause = campos.map((k, i) => `${k} = $${i + 1}`).join(', ');
      
      await pool.query(
        `UPDATE politicas SET ${setClause}, actualizado_en = NOW() WHERE id = $${campos.length + 1}`,
        [...valores, existe.rows[0].id]
      );
    } else {
      // Insertar
      const campos = Object.keys(politicas);
      const valores = campos.map(k => politicas[k]);
      const placeholders = campos.map((_, i) => `$${i + 1}`).join(', ');
      
      await pool.query(
        `INSERT INTO politicas (${campos.join(', ')}) VALUES (${placeholders})`,
        valores
      );
    }
    
    await actualizarArchivoEspejo();
    await generarEspejo();
    
    res.json({
      exito: true,
      mensaje: "Políticas actualizadas"
    });
  } catch (error) {
    console.error('Error actualizando políticas:', error);
    res.status(500).json({ exito: false, mensaje: "Error al actualizar políticas" });
  }
});

// Historial de cambios
app.get('/api/admin/historial', async (req, res) => {
  const { limite = 100, tipo, entidad } = req.query;
  
  try {
    let query = 'SELECT * FROM historial_cambios WHERE 1=1';
    const params = [];
    let paramCount = 1;
    
    if (tipo) {
      query += ` AND tipo = $${paramCount}`;
      params.push(tipo);
      paramCount++;
    }
    
    if (entidad) {
      query += ` AND entidad = $${paramCount}`;
      params.push(entidad);
      paramCount++;
    }
    
    query += ` ORDER BY fecha DESC LIMIT $${paramCount}`;
    params.push(limite);
    
    const historial = await pool.query(query, params);
    
    res.json({ 
      exito: true, 
      historial: historial.rows,
      total: historial.rows.length
    });
  } catch (error) {
    res.status(500).json({ exito: false, mensaje: "Error al obtener historial" });
  }
});

// Estadísticas
app.get('/api/admin/estadisticas', async (req, res) => {
  const { fecha_inicio, fecha_fin } = req.query;
  
  try {
    const fechaInicio = fecha_inicio || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const fechaFin = fecha_fin || new Date().toISOString().split('T')[0];
    
    // Reservas por día
    const reservasPorDia = await pool.query(`
      SELECT 
        fecha,
        COUNT(*) as total,
        COUNT(CASE WHEN estado = 'confirmada' THEN 1 END) as confirmadas,
        COUNT(CASE WHEN estado = 'cancelada' THEN 1 END) as canceladas,
        COUNT(CASE WHEN estado = 'no_show' THEN 1 END) as no_shows,
        SUM(CASE WHEN estado = 'confirmada' THEN personas ELSE 0 END) as personas
      FROM reservas
      WHERE fecha BETWEEN $1 AND $2
      GROUP BY fecha
      ORDER BY fecha
    `, [fechaInicio, fechaFin]);
    
    // Top clientes
    const topClientes = await pool.query(`
      SELECT 
        c.nombre, c.telefono,
        COUNT(r.id) as reservas,
        SUM(r.personas) as total_personas,
        AVG(r.valoracion) as valoracion_media
      FROM clientes c
      JOIN reservas r ON c.id = r.cliente_id
      WHERE r.fecha BETWEEN $1 AND $2
        AND r.estado = 'confirmada'
      GROUP BY c.id, c.nombre, c.telefono
      ORDER BY COUNT(r.id) DESC
      LIMIT 10
    `, [fechaInicio, fechaFin]);
    
    // Platos más pedidos (si tienes sistema de pedidos)
    // Por ahora, mostraremos los platos más vistos
    const platosPopulares = await pool.query(`
      SELECT nombre, precio, categoria_id
      FROM platos
      WHERE disponible = true AND recomendado = true
      LIMIT 10
    `);
    
    res.json({
      exito: true,
      estadisticas: {
        periodo: { inicio: fechaInicio, fin: fechaFin },
        reservas_por_dia: reservasPorDia.rows,
        top_clientes: topClientes.rows,
        platos_populares: platosPopulares.rows
      }
    });
  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    res.status(500).json({ exito: false, mensaje: "Error al obtener estadísticas" });
  }
});

// Añadir estos endpoints al archivo server.js después de los endpoints existentes

// ============================================
// ENDPOINTS - GESTIÓN DE HORARIOS
// ============================================

// Obtener todos los horarios
app.get('/api/admin/horarios', async (req, res) => {
  try {
    const horarios = await pool.query(`
      SELECT 
        id,
        dia_semana,
        apertura,
        cierre,
        turno_comida_inicio,
        turno_comida_fin,
        turno_cena_inicio,
        turno_cena_fin,
        cerrado,
        capacidad_reducida,
        porcentaje_capacidad
      FROM horarios 
      ORDER BY dia_semana
    `);

    // Convertir a formato más usable para el frontend
    const horariosFormateados = [];
    const diasSemana = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
    
    for (let i = 0; i <= 6; i++) {
      const horarioDia = horarios.rows.find(h => h.dia_semana === i);
      horariosFormateados.push({
        dia_semana: i,
        nombre_dia: diasSemana[i],
        apertura: horarioDia?.apertura || null,
        cierre: horarioDia?.cierre || null,
        turno_comida_inicio: horarioDia?.turno_comida_inicio || null,
        turno_comida_fin: horarioDia?.turno_comida_fin || null,
        turno_cena_inicio: horarioDia?.turno_cena_inicio || null,
        turno_cena_fin: horarioDia?.turno_cena_fin || null,
        cerrado: horarioDia?.cerrado || false,
        capacidad_reducida: horarioDia?.capacidad_reducida || false,
        porcentaje_capacidad: horarioDia?.porcentaje_capacidad || 100
      });
    }

    res.json({
      exito: true,
      horarios: horariosFormateados
    });

  } catch (error) {
    console.error('❌ Error obteniendo horarios:', error);
    res.status(500).json({
      exito: false,
      mensaje: 'Error interno del servidor',
      error: error.message
    });
  }
});

// Actualizar horarios
app.put('/api/admin/horarios', async (req, res) => {
  try {
    // Limpiar cache de horarios antes de la actualización
    limpiarCacheHorarios();
    
    const { horarios } = req.body;

    if (!horarios || !Array.isArray(horarios)) {
      return res.status(400).json({
        exito: false,
        mensaje: 'Se requiere un array de horarios'
      });
    }

    // Iniciar transacción
    await pool.query('BEGIN');

    try {
      // Eliminar horarios existentes
      await pool.query('DELETE FROM horarios');

      // Insertar nuevos horarios
      for (const horario of horarios) {
        if (!horario.cerrado) {
          await pool.query(`
            INSERT INTO horarios (
              dia_semana, apertura, cierre, turno_comida_inicio, turno_comida_fin,
              turno_cena_inicio, turno_cena_fin, cerrado, capacidad_reducida, porcentaje_capacidad
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `, [
            horario.dia_semana,
            horario.apertura,
            horario.cierre,
            horario.turno_comida_inicio,
            horario.turno_comida_fin,
            horario.turno_cena_inicio,
            horario.turno_cena_fin,
            false,
            horario.capacidad_reducida || false,
            horario.porcentaje_capacidad || 100
          ]);
        } else {
          // Para días cerrados, solo marcar como cerrado
          await pool.query(`
            INSERT INTO horarios (dia_semana, cerrado) VALUES ($1, true)
          `, [horario.dia_semana]);
        }
      }

      await pool.query('COMMIT');

      // Actualizar archivo espejo
      await actualizarArchivoEspejo();

      res.json({
        exito: true,
        mensaje: 'Horarios actualizados correctamente'
      });

    } catch (innerError) {
      await pool.query('ROLLBACK');
      throw innerError;
    }

  } catch (error) {
    console.error('❌ Error actualizando horarios:', error);
    res.status(500).json({
      exito: false,
      mensaje: 'Error interno del servidor',
      error: error.message
    });
  }
});

// Actualizar horario de un día específico
app.put('/api/admin/horarios/:dia', async (req, res) => {
  try {
    // Limpiar cache de horarios antes de la actualización
    limpiarCacheHorarios();
    
    const dia = parseInt(req.params.dia);
    const horario = req.body;

    if (dia < 0 || dia > 6) {
      return res.status(400).json({
        exito: false,
        mensaje: 'Día de semana inválido (0-6)'
      });
    }

    if (horario.cerrado) {
      // Marcar día como cerrado
      await pool.query(`
        INSERT INTO horarios (dia_semana, cerrado) 
        VALUES ($1, true)
        ON CONFLICT (dia_semana) 
        DO UPDATE SET 
          cerrado = true,
          apertura = NULL,
          cierre = NULL,
          turno_comida_inicio = NULL,
          turno_comida_fin = NULL,
          turno_cena_inicio = NULL,
          turno_cena_fin = NULL
      `, [dia]);
    } else {
      // Actualizar horarios del día
      await pool.query(`
        INSERT INTO horarios (
          dia_semana, apertura, cierre, turno_comida_inicio, turno_comida_fin,
          turno_cena_inicio, turno_cena_fin, cerrado, capacidad_reducida, porcentaje_capacidad
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9)
        ON CONFLICT (dia_semana) 
        DO UPDATE SET 
          apertura = EXCLUDED.apertura,
          cierre = EXCLUDED.cierre,
          turno_comida_inicio = EXCLUDED.turno_comida_inicio,
          turno_comida_fin = EXCLUDED.turno_comida_fin,
          turno_cena_inicio = EXCLUDED.turno_cena_inicio,
          turno_cena_fin = EXCLUDED.turno_cena_fin,
          cerrado = false,
          capacidad_reducida = EXCLUDED.capacidad_reducida,
          porcentaje_capacidad = EXCLUDED.porcentaje_capacidad
      `, [
        dia,
        horario.apertura,
        horario.cierre,
        horario.turno_comida_inicio,
        horario.turno_comida_fin,
        horario.turno_cena_inicio,
        horario.turno_cena_fin,
        horario.capacidad_reducida || false,
        horario.porcentaje_capacidad || 100
      ]);
    }

    // Actualizar archivo espejo
    await actualizarArchivoEspejo();

    res.json({
      exito: true,
      mensaje: `Horario del ${['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][dia]} actualizado correctamente`
    });

  } catch (error) {
    console.error('❌ Error actualizando horario del día:', error);
    res.status(500).json({
      exito: false,
      mensaje: 'Error interno del servidor',
      error: error.message
    });
  }
});

// ============================================
// ENDPOINTS - INFORMACIÓN DEL RESTAURANTE
// ============================================

// Obtener información del restaurante
app.get('/api/admin/restaurante', async (req, res) => {
  try {
    const resultado = await pool.query('SELECT * FROM restaurante LIMIT 1');
    
    if (resultado.rows.length === 0) {
      // Si no existe, crear registro por defecto
      const nuevoRestaurante = await pool.query(`
        INSERT INTO restaurante (
          nombre, tipo_cocina, direccion, telefono, email, web, descripcion
        ) VALUES (
          'Mi Restaurante', 
          'Mediterránea',
          'Calle Principal 123, Barcelona', 
          '+34 900 123 456',
          'info@mirestaurante.com',
          'www.mirestaurante.com',
          'Cocina mediterránea moderna'
        ) RETURNING *
      `);
      
      await actualizarArchivoEspejo();
      await generarEspejo();
      
      return res.json({
        exito: true,
        restaurante: nuevoRestaurante.rows[0]
      });
    }
    
    res.json({
      exito: true,
      restaurante: resultado.rows[0]
    });
  } catch (error) {
    console.error('Error obteniendo información del restaurante:', error);
    res.status(500).json({
      exito: false,
      mensaje: "Error al obtener información del restaurante"
    });
  }
});

// Actualizar información del restaurante
app.put('/api/admin/restaurante', async (req, res) => {
  const {
    nombre,
    tipo_cocina,
    direccion,
    telefono,
    email,
    web,
    descripcion,
    facebook,
    instagram,
    twitter,
    tripadvisor
  } = req.body;
  
  try {
    // Verificar si existe un registro
    const existe = await pool.query('SELECT id FROM restaurante LIMIT 1');
    
    let resultado;
    
    if (existe.rows.length > 0) {
      // Actualizar registro existente
      resultado = await pool.query(`
        UPDATE restaurante 
        SET 
          nombre = COALESCE($1, nombre),
          tipo_cocina = COALESCE($2, tipo_cocina),
          direccion = COALESCE($3, direccion),
          telefono = COALESCE($4, telefono),
          email = COALESCE($5, email),
          web = COALESCE($6, web),
          descripcion = COALESCE($7, descripcion),
          facebook = COALESCE($8, facebook),
          instagram = COALESCE($9, instagram),
          twitter = COALESCE($10, twitter),
          tripadvisor = COALESCE($11, tripadvisor),
          actualizado_en = NOW()
        WHERE id = $12
        RETURNING *
      `, [
        nombre, tipo_cocina, direccion, telefono, email, web, 
        descripcion, facebook, instagram, twitter, tripadvisor,
        existe.rows[0].id
      ]);
    } else {
      // Crear nuevo registro
      resultado = await pool.query(`
        INSERT INTO restaurante (
          nombre, tipo_cocina, direccion, telefono, email, web, 
          descripcion, facebook, instagram, twitter, tripadvisor
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
      `, [
        nombre || 'Mi Restaurante',
        tipo_cocina || 'Mediterránea',
        direccion || 'Dirección no especificada',
        telefono || '+34 900 000 000',
        email || 'info@restaurante.com',
        web || 'www.restaurante.com',
        descripcion || 'Descripción del restaurante',
        facebook, instagram, twitter, tripadvisor
      ]);
    }
    
    // Registrar cambio en historial
    await registrarCambio(
      'actualizar_restaurante',
      resultado.rows[0].id,
      existe.rows[0] || null,
      resultado.rows[0],
      'admin'
    );
    
    // Actualizar archivo espejo inmediatamente
    await actualizarArchivoEspejo();
    await generarEspejo();
    
    res.json({
      exito: true,
      restaurante: resultado.rows[0],
      mensaje: "Información del restaurante actualizada correctamente"
    });
    
  } catch (error) {
    console.error('Error actualizando información del restaurante:', error);
    res.status(500).json({
      exito: false,
      mensaje: "Error al actualizar información del restaurante"
    });
  }
});

// ============================================
// INICIALIZACIÓN
// ============================================

async function inicializarDB() {
  try {
    console.log('🔄 Intentando conectar a la base de datos...');
    
    // Verificar conexión
    await pool.query('SELECT NOW()');
    console.log('✅ Conexión a base de datos establecida');
    console.log('🔄 Aplicando migraciones...');
    try {
      await pool.query(`
        ALTER TABLE restaurante 
        ADD COLUMN IF NOT EXISTS tipo_cocina VARCHAR(100) DEFAULT 'Mediterránea',
        ADD COLUMN IF NOT EXISTS facebook VARCHAR(200),
        ADD COLUMN IF NOT EXISTS instagram VARCHAR(200),
        ADD COLUMN IF NOT EXISTS twitter VARCHAR(200),
        ADD COLUMN IF NOT EXISTS tripadvisor VARCHAR(200)
      `);
      
      // Agregar columna nombre a mesas
      await pool.query(`
        ALTER TABLE mesas 
        ADD COLUMN IF NOT EXISTS nombre VARCHAR(100)
      `);
      
      console.log('✅ Migraciones aplicadas');
    } catch (migrationError) {
      console.log('ℹ️ Migraciones ya aplicadas o error:', migrationError.message);
    }
    
    // Crear tablas si no existen (para Railway)
    if (isProduction) {
      console.log('🏗️ Verificando/creando estructura de base de datos...');
      
      try {
        // Ejecutar el script de inicialización
        const initDatabase = require('./init-database');
        await initDatabase();
      } catch (initError) {
        console.log('ℹ️ Las tablas ya existen o fueron creadas manualmente');
      }
    }
    
    // Verificar si existen las tablas principales
    const tablaRestaurante = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'restaurante'
      );
    `);
    
    if (!tablaRestaurante.rows[0].exists) {
      console.log('⚠️  Las tablas no existen. Creando estructura de base de datos...');
      
      // Si las tablas no existen, intentar crearlas
      const initDatabase = require('./init-database');
      await initDatabase();
    }
    
    console.log('✅ Base de datos inicializada correctamente');
    
  } catch (error) {
    console.error('❌ Error conectando a la base de datos:', error);
    
    if (isProduction) {
      console.log('🔧 En Railway: Verifica que hayas añadido PostgreSQL a tu proyecto');
      console.log('   Las variables DATABASE_URL deberían estar configuradas automáticamente');
      
      // En producción, esperar y reintentar
      console.log('⏳ Reintentando conexión en 10 segundos...');
      setTimeout(() => {
        inicializarDB();
      }, 10000);
    } else {
      console.log('Por favor, verifica la configuración de PostgreSQL local');
      process.exit(1);
    }
  }
}

// ============================================
// ENDPOINTS DE DEBUG PARA SOLAPAMIENTOS
// ============================================

// Debug: Estado detallado de una mesa específica
app.get('/api/debug/mesa/:id', async (req, res) => {
  const mesaId = parseInt(req.params.id);
  const fecha = req.query.fecha || new Date().toISOString().split('T')[0];
  
  console.log(`\n🐛 [DEBUG] Estado de mesa ${mesaId} para ${fecha}`);
  
  try {
    // Información de la mesa
    const mesaInfo = await pool.query('SELECT * FROM mesas WHERE id = $1', [mesaId]);
    if (mesaInfo.rows.length === 0) {
      return res.status(404).json({ error: `Mesa ${mesaId} no encontrada` });
    }
    
    // Reservas para esta mesa en la fecha
    const reservas = await pool.query(`
      SELECT r.*, c.nombre, c.telefono
      FROM reservas r
      JOIN clientes c ON r.cliente_id = c.id
      WHERE r.mesa_id = $1 
        AND r.fecha = $2
        AND r.estado IN ('confirmada', 'pendiente')
      ORDER BY r.hora
    `, [mesaId, fecha]);
    
    // Verificar si hay reserva en curso
    const ahora = new Date();
    const reservasEnCurso = await pool.query(`
      SELECT r.*, c.nombre
      FROM reservas r
      JOIN clientes c ON r.cliente_id = c.id
      WHERE r.mesa_id = $1
        AND r.fecha = $2
        AND r.estado = 'confirmada'
        AND NOW()::TIME BETWEEN r.hora 
        AND (r.hora + COALESCE(r.duracion, 90) * INTERVAL '1 minute')
    `, [mesaId, fecha]);
    
    // Log especial para mesa 3
    if (mesaId === 3) {
      console.log(`🎯 [MESA 3 DEBUG] Total reservas: ${reservas.rows.length}`);
      console.log(`🎯 [MESA 3 DEBUG] En curso: ${reservasEnCurso.rows.length}`);
    }
    
    res.json({
      mesa: mesaInfo.rows[0],
      fecha: fecha,
      reservas_totales: reservas.rows.length,
      reservas: reservas.rows.map(r => ({
        codigo: r.codigo_reserva,
        cliente: r.nombre,
        telefono: r.telefono,
        hora_inicio: r.hora,
        duracion: r.duracion,
        hora_fin: `${Math.floor((parseInt(r.hora.split(':')[0]) * 60 + parseInt(r.hora.split(':')[1]) + (r.duracion || 90)) / 60)}:${String((parseInt(r.hora.split(':')[0]) * 60 + parseInt(r.hora.split(':')[1]) + (r.duracion || 90)) % 60).padStart(2, '0')}`,
        estado: r.estado,
        origen: r.origen
      })),
      reservas_en_curso: reservasEnCurso.rows.length > 0 ? reservasEnCurso.rows[0] : null,
      es_mesa_3: mesaId === 3
    });
    
  } catch (error) {
    console.error(`Error debugeando mesa ${mesaId}:`, error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Debug: Ver todas las reservas de una fecha
app.get('/api/debug/reservas/:fecha', async (req, res) => {
  const fecha = req.params.fecha;
  
  console.log(`\n🐛 [DEBUG] Reservas para ${fecha}`);
  
  try {
    const reservas = await pool.query(`
      SELECT 
        r.*, 
        c.nombre, 
        c.telefono, 
        m.numero_mesa,
        m.capacidad,
        m.zona
      FROM reservas r
      JOIN clientes c ON r.cliente_id = c.id
      JOIN mesas m ON r.mesa_id = m.id
      WHERE r.fecha = $1
        AND r.estado IN ('confirmada', 'pendiente')
      ORDER BY m.numero_mesa, r.hora
    `, [fecha]);
    
    // Agrupar por mesa
    const reservasPorMesa = {};
    reservas.rows.forEach(r => {
      if (!reservasPorMesa[r.mesa_id]) {
        reservasPorMesa[r.mesa_id] = {
          numero_mesa: r.numero_mesa,
          capacidad: r.capacidad,
          zona: r.zona,
          reservas: []
        };
      }
      
      reservasPorMesa[r.mesa_id].reservas.push({
        codigo: r.codigo_reserva,
        cliente: r.nombre,
        telefono: r.telefono,
        hora_inicio: r.hora,
        duracion: r.duracion,
        hora_fin: `${Math.floor((parseInt(r.hora.split(':')[0]) * 60 + parseInt(r.hora.split(':')[1]) + (r.duracion || 90)) / 60)}:${String((parseInt(r.hora.split(':')[0]) * 60 + parseInt(r.hora.split(':')[1]) + (r.duracion || 90)) % 60).padStart(2, '0')}`,
        estado: r.estado,
        origen: r.origen
      });
    });
    
    // Detectar solapamientos
    const solapamientos = [];
    Object.keys(reservasPorMesa).forEach(mesaId => {
      const mesa = reservasPorMesa[mesaId];
      for (let i = 0; i < mesa.reservas.length - 1; i++) {
        for (let j = i + 1; j < mesa.reservas.length; j++) {
          const r1 = mesa.reservas[i];
          const r2 = mesa.reservas[j];
          
          const inicio1 = parseInt(r1.hora_inicio.split(':')[0]) * 60 + parseInt(r1.hora_inicio.split(':')[1]);
          const fin1 = inicio1 + (r1.duracion || 90);
          const inicio2 = parseInt(r2.hora_inicio.split(':')[0]) * 60 + parseInt(r2.hora_inicio.split(':')[1]);
          const fin2 = inicio2 + (r2.duracion || 90);
          
          if (inicio1 < fin2 && inicio2 < fin1) {
            solapamientos.push({
              mesa: mesa.numero_mesa,
              reserva1: r1.codigo,
              reserva2: r2.codigo,
              horario1: `${r1.hora_inicio}-${r1.hora_fin}`,
              horario2: `${r2.hora_inicio}-${r2.hora_fin}`
            });
          }
        }
      }
    });
    
    res.json({
      fecha: fecha,
      total_reservas: reservas.rows.length,
      mesas_con_reservas: Object.keys(reservasPorMesa).length,
      reservas_por_mesa: reservasPorMesa,
      solapamientos_detectados: solapamientos.length,
      solapamientos: solapamientos
    });
    
  } catch (error) {
    console.error(`Error debugeando reservas ${fecha}:`, error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Arrancar servidor
app.listen(PORT, async () => {
  console.log(`\n🚀 GastroBot Backend API iniciado`);
  console.log(`📍 URL: http://localhost:${PORT}`);
  console.log(`📚 Documentación de endpoints:`);
  console.log(`   - GET  /api/espejo                  → Archivo espejo completo`);
  console.log(`   - POST /api/buscar-mesa             → Buscar disponibilidad`);
  console.log(`   - POST /api/crear-reserva           → Crear nueva reserva`);
  console.log(`   - PUT  /api/modificar-reserva       → Modificar reserva`);
  console.log(`   - DEL  /api/cancelar-reserva        → Cancelar reserva`);
  console.log(`   - GET  /api/ver-menu                → Ver menú del restaurante`);
  console.log(`   - GET  /api/consultar-horario       → Consultar horarios`);
  console.log(`   - GET  /api/debug/mesa/:id          → Debug estado de mesa específica`);
  console.log(`   - GET  /api/debug/reservas/:fecha   → Debug reservas por fecha`);
  console.log(`   - GET  /api/admin/horarios          → Obtener horarios del restaurante`);
  console.log(`   - PUT  /api/admin/horarios          → Actualizar horarios del restaurante`);
  console.log(`   - PUT  /api/admin/horarios/:dia     → Actualizar horario de un día específico`);
  console.log(`   - GET  /api/admin/*                 → Endpoints del dashboard\n`);
  
  await inicializarDB();
  await actualizarArchivoEspejo();
  await generarEspejo();
  
  console.log('✅ Sistema listo para recibir peticiones del GPT\n');
});

// Manejo de cierre graceful
process.on('SIGTERM', () => {
  console.log('Cerrando servidor...');
  pool.end();
  process.exit(0);
});