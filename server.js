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

const app = express();
const PORT = process.env.PORT || 3002;

// Middlewares
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001', 
    'https://dashboard-2-production.up.railway.app',
    // Añade aquí la URL de tu dashboard si es diferente
    true // Permite cualquier origen temporalmente para debug
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

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
        AND NOW()::TIME BETWEEN r.hora AND (r.hora + r.duracion * INTERVAL '1 minute')
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
    
    // Guardar en archivo físico como respaldo
    await fs.writeFile(
      path.join(__dirname, 'archivo_espejo.json'),
      JSON.stringify(archivoEspejo, null, 2)
    );
    
    console.log(`✅ Archivo Espejo actualizado en ${Date.now() - inicio}ms`);
    return true;
    
  } catch (error) {
    console.error('❌ Error actualizando Archivo Espejo:', error);
    return false;
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

// ENDPOINT PRINCIPAL: Obtener Archivo Espejo completo
app.get('/api/espejo', verificarFrescura, (req, res) => {
  res.json({
    exito: true,
    datos: archivoEspejo,
    mensaje: "Datos actualizados del restaurante"
  });
});

// Consultar horario específico
app.get('/api/consultar-horario', verificarFrescura, (req, res) => {
  const { fecha } = req.query;
  
  if (!fecha) {
    return res.json({
      exito: false,
      mensaje: "Se requiere una fecha"
    });
  }
  
  // Buscar excepciones primero
  const excepcion = archivoEspejo.horarios.excepciones?.find(e => 
    e.fecha === fecha
  );
  
  if (excepcion) {
    return res.json({
      exito: true,
      horario: excepcion,
      es_excepcion: true,
      mensaje: excepcion.cerrado ? `Cerrado el ${fecha}: ${excepcion.motivo}` : `Horario especial el ${fecha}`
    });
  }
  
  // Si no hay excepción, devolver horario regular
  const diaSemana = new Date(fecha).getDay();
  const horarioRegular = archivoEspejo.horarios.regular?.find(h => 
    h.dia_semana === diaSemana
  );
  
  res.json({
    exito: true,
    horario: horarioRegular || { cerrado: true },
    es_excepcion: false,
    mensaje: horarioRegular?.cerrado ? "Cerrado este día" : "Horario regular"
  });
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
app.post('/api/buscar-mesa', verificarFrescura, async (req, res) => {
  const { fecha, hora, personas, duracion = 120 } = req.body;
  
  // Validación de entrada
  if (!fecha || !hora || !personas) {
    return res.status(400).json({
      exito: false,
      mensaje: "Se requiere fecha, hora y número de personas"
    });
  }
  
  try {
    // Buscar mesas disponibles
    const query = await pool.query(`
      SELECT m.* FROM mesas m
      WHERE m.capacidad >= $1
        AND m.capacidad <= $1 + 2  -- No asignar mesas demasiado grandes
        AND m.activa = true
        AND NOT EXISTS (
          SELECT 1 FROM reservas r
          WHERE r.mesa_id = m.id
            AND r.fecha = $2
            AND r.estado IN ('confirmada', 'pendiente')
            AND (
              (r.hora <= $3::TIME AND (r.hora + r.duracion * INTERVAL '1 minute') > $3::TIME)
              OR
              ($3::TIME <= r.hora AND ($3::TIME + $4 * INTERVAL '1 minute') > r.hora)
            )
        )
      ORDER BY m.capacidad, m.numero_mesa
      LIMIT 1
    `, [personas, fecha, hora, duracion]);
    
    if (query.rows.length > 0) {
      const mesa = query.rows[0];
      res.json({
        exito: true,
        mesa_disponible: mesa,
        mensaje: `Mesa ${mesa.numero_mesa} disponible (capacidad: ${mesa.capacidad} personas, zona: ${mesa.zona || 'principal'})`
      });
    } else {
      // Buscar alternativas cercanas
      const alternativasQuery = await pool.query(`
        WITH horarios_posibles AS (
          SELECT 
            to_char(hora_slot, 'HH24:MI') as hora_alternativa,
            hora_slot,
            COUNT(DISTINCT m.id) as mesas_disponibles
          FROM (
            SELECT generate_series(
              $2::TIME - INTERVAL '90 minutes',
              $2::TIME + INTERVAL '90 minutes',
              INTERVAL '30 minutes'
            ) as hora_slot
          ) slots
          CROSS JOIN mesas m
          WHERE m.capacidad >= $1
            AND m.capacidad <= $1 + 2
            AND m.activa = true
            AND NOT EXISTS (
              SELECT 1 FROM reservas r
              WHERE r.mesa_id = m.id
                AND r.fecha = $3
                AND r.estado IN ('confirmada', 'pendiente')
                AND (
                  (r.hora <= hora_slot AND (r.hora + r.duracion * INTERVAL '1 minute') > hora_slot)
                  OR
                  (hora_slot <= r.hora AND (hora_slot + $4 * INTERVAL '1 minute') > r.hora)
                )
            )
          GROUP BY hora_slot
          HAVING COUNT(DISTINCT m.id) > 0
        )
        SELECT hora_alternativa, mesas_disponibles
        FROM horarios_posibles
        WHERE hora_slot != $2::TIME
        ORDER BY ABS(EXTRACT(EPOCH FROM (hora_slot - $2::TIME)))
        LIMIT 6
      `, [personas, hora, fecha, duracion]);
      
      res.json({
        exito: false,
        mensaje: `No hay mesas para ${personas} personas el ${fecha} a las ${hora}`,
        alternativas: alternativasQuery.rows,
        sugerencia: alternativasQuery.rows.length > 0 ? 
          `Te sugiero ${alternativasQuery.rows[0].hora_alternativa} (${alternativasQuery.rows[0].mesas_disponibles} mesas disponibles)` : 
          "No hay disponibilidad cercana. Prueba otro día."
      });
    }
  } catch (error) {
    console.error('Error buscando mesa:', error);
    res.status(500).json({
      exito: false,
      mensaje: "Error al buscar disponibilidad"
    });
  }
});

// Crear reserva (ENDPOINT PRINCIPAL PARA RESERVAS)
app.post('/api/crear-reserva', verificarFrescura, async (req, res) => {
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
    duracion = 120 
  } = req.body;
  
  // Validación completa
  if (!nombre || !telefono || !fecha || !hora || !personas) {
    return res.status(400).json({
      exito: false,
      mensaje: "Faltan datos obligatorios: nombre, teléfono, fecha, hora y personas"
    });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Si no se proporciona mesa_id, buscar una automáticamente
    let mesaAsignada = mesa_id;
    if (!mesaAsignada) {
      const mesaQuery = await client.query(`
        SELECT m.id FROM mesas m
        WHERE m.capacidad >= $1
          AND m.capacidad <= $1 + 2
          AND m.activa = true
          AND NOT EXISTS (
            SELECT 1 FROM reservas r
            WHERE r.mesa_id = m.id
              AND r.fecha = $2
              AND r.estado IN ('confirmada', 'pendiente')
              AND (
                (r.hora <= $3::TIME AND (r.hora + r.duracion * INTERVAL '1 minute') > $3::TIME)
                OR
                ($3::TIME <= r.hora AND ($3::TIME + $4 * INTERVAL '1 minute') > r.hora)
              )
          )
        ORDER BY m.capacidad, m.numero_mesa
        LIMIT 1
      `, [personas, fecha, hora, duracion]);
      
      if (mesaQuery.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          exito: false,
          mensaje: "No hay mesas disponibles para esa fecha y hora"
        });
      }
      
      mesaAsignada = mesaQuery.rows[0].id;
    }
    
    // Crear o buscar cliente
    let clienteQuery = await client.query(
      'SELECT id FROM clientes WHERE telefono = $1',
      [telefono]
    );
    
    let cliente_id;
    if (clienteQuery.rows.length === 0) {
      const nuevoCliente = await client.query(
        'INSERT INTO clientes (nombre, telefono, email, alergias) VALUES ($1, $2, $3, $4) RETURNING id',
        [nombre, telefono, email, alergias ? [alergias] : null]
      );
      cliente_id = nuevoCliente.rows[0].id;
    } else {
      cliente_id = clienteQuery.rows[0].id;
      // Actualizar datos del cliente
      await client.query(
        `UPDATE clientes 
         SET nombre = $1, 
             email = COALESCE($2, email),
             alergias = CASE WHEN $3 IS NOT NULL THEN array_append(alergias, $3) ELSE alergias END,
             total_reservas = total_reservas + 1
         WHERE id = $4`,
        [nombre, email, alergias, cliente_id]
      );
    }
    
    // Generar código de reserva único
    const codigoReserva = Math.random().toString(36).substring(2, 10).toUpperCase();
    
    // Crear reserva
    const reservaQuery = await client.query(`
      INSERT INTO reservas (
        codigo_reserva, cliente_id, mesa_id, fecha, hora, personas, 
        notas, notas_alergias, celebracion, duracion, estado, origen, creada_en
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'confirmada', 'gpt', NOW())
      RETURNING *
    `, [codigoReserva, cliente_id, mesaAsignada, fecha, hora, personas, 
        notas, alergias, celebracion, duracion]);
    
    const reserva = reservaQuery.rows[0];
    
    // Obtener información de la mesa
    const mesaInfo = await client.query('SELECT * FROM mesas WHERE id = $1', [mesaAsignada]);
    
    // Registrar cambio
    await registrarCambio('crear_reserva', reserva.id, null, reserva, 'gpt');
    
    await client.query('COMMIT');
    
    // Actualizar Archivo Espejo inmediatamente
    await actualizarArchivoEspejo();
    
    res.json({
      exito: true,
      reserva: {
        ...reserva,
        mesa: mesaInfo.rows[0]
      },
      codigo_reserva: codigoReserva,
      mensaje: `¡Reserva confirmada! Mesa ${mesaInfo.rows[0].numero_mesa} para ${personas} personas el ${fecha} a las ${hora}. Código: ${codigoReserva}`,
      recordatorio: `Recuerda: Cancelaciones con ${archivoEspejo.politicas.cancelacion_horas || 24}h de antelación`
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creando reserva:', error);
    res.status(500).json({
      exito: false,
      mensaje: "Error al crear la reserva. Por favor, intenta de nuevo."
    });
  } finally {
    client.release();
  }
});

// Modificar reserva
app.put('/api/modificar-reserva', verificarFrescura, async (req, res) => {
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
      
      // Buscar nueva mesa si es necesario
      const mesaQuery = await client.query(`
        SELECT m.id FROM mesas m
        WHERE m.capacidad >= $1
          AND m.activa = true
          AND NOT EXISTS (
            SELECT 1 FROM reservas r
            WHERE r.mesa_id = m.id
              AND r.fecha = $2
              AND r.hora = $3::TIME
              AND r.estado = 'confirmada'
              AND r.id != $4
          )
        ORDER BY m.capacidad
        LIMIT 1
      `, [nuevasPersonas, nuevaFecha, nuevaHora, reserva.id]);
      
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

// Cancelar reserva
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
  console.log(`   - GET  /api/admin/*                 → Endpoints del dashboard\n`);
  
  await inicializarDB();
  await actualizarArchivoEspejo();
  
  console.log('✅ Sistema listo para recibir peticiones del GPT\n');
});

// Manejo de cierre graceful
process.on('SIGTERM', () => {
  console.log('Cerrando servidor...');
  pool.end();
  process.exit(0);
});