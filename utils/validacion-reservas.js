/**
 * Sistema Centralizado de Validación de Reservas
 * Resuelve problemas de solapamiento, especialmente en mesa 3
 */

const { Pool } = require('pg');

/**
 * Verifica si hay solapamiento entre dos intervalos de tiempo
 * @param {string} inicio1 - Hora inicio primera reserva (HH:MM)
 * @param {number} duracion1 - Duración en minutos
 * @param {string} inicio2 - Hora inicio segunda reserva (HH:MM)
 * @param {number} duracion2 - Duración en minutos
 * @returns {boolean} true si hay solapamiento
 */
function haySolapamiento(inicio1, duracion1, inicio2, duracion2) {
  // Convertir horas a minutos
  const [h1, m1] = inicio1.split(':').map(Number);
  const [h2, m2] = inicio2.split(':').map(Number);
  
  const minutosInicio1 = h1 * 60 + m1;
  const minutosFin1 = minutosInicio1 + duracion1;
  
  const minutosInicio2 = h2 * 60 + m2;
  const minutosFin2 = minutosInicio2 + duracion2;
  
  // Lógica de intervalos: hay solapamiento si inicio1 < fin2 Y inicio2 < fin1
  const solapamiento = minutosInicio1 < minutosFin2 && minutosInicio2 < minutosFin1;
  
  if (solapamiento) {
    console.log(`⚠️ [SOLAPAMIENTO] Detectado entre ${inicio1}-${formatearMinutos(minutosFin1)} y ${inicio2}-${formatearMinutos(minutosFin2)}`);
  }
  
  return solapamiento;
}

/**
 * Formatea minutos a HH:MM
 */
function formatearMinutos(minutos) {
  const horas = Math.floor(minutos / 60);
  const mins = minutos % 60;
  return `${String(horas).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/**
 * Verifica solapamientos para una reserva específica
 * Consulta DIRECTAMENTE la base de datos, no usa archivo espejo
 * @param {Pool} pool - Pool de conexiones PostgreSQL
 * @param {number} mesaId - ID de la mesa
 * @param {string} fecha - Fecha de la reserva (YYYY-MM-DD)
 * @param {string} hora - Hora de inicio (HH:MM)
 * @param {number} duracion - Duración en minutos
 * @param {string} reservaIdExcluir - ID de reserva a excluir (para modificaciones)
 * @param {number} duracionPorDefecto - Duración por defecto cuando no está especificada en la reserva
 * @returns {Promise<{valido: boolean, conflictos: Array, mensaje: string}>}
 */
async function verificarSolapamiento(pool, mesaId, fecha, hora, duracion, reservaIdExcluir = null, duracionPorDefecto = 120) {
  // CRÍTICO: Asegurar que duracionPorDefecto sea siempre el valor actual de BD
  const timestamp = new Date().toISOString();
  console.log(`🔍 [SOLAPAMIENTO ${timestamp}] Verificando con duración: ${duracion}, defecto: ${duracionPorDefecto}`);
  const esMesa3 = mesaId === 3;
  
  if (esMesa3) {
    console.log(`\n🔍 [MESA 3 - VALIDACIÓN ESPECIAL] Verificando solapamientos para mesa crítica`);
    console.log(`   📅 Fecha: ${fecha}`);
    console.log(`   🕐 Hora: ${hora}`);
    console.log(`   ⏱️ Duración: ${duracion} minutos`);
  }
  
  try {
    // Consulta DIRECTA a la BD - no usar archivo espejo
    let query = `
      SELECT 
        r.id,
        r.codigo_reserva,
        r.hora,
        COALESCE(r.duracion, $3) as duracion,
        r.estado,
        c.nombre as cliente_nombre,
        r.origen
      FROM reservas r
      JOIN clientes c ON r.cliente_id = c.id
      WHERE r.mesa_id = $1
        AND r.fecha = $2
        AND r.estado IN ('confirmada', 'pendiente')
    `;
    
    const params = [mesaId, fecha, duracionPorDefecto];
    
    // Si hay una reserva a excluir (modificación)
    if (reservaIdExcluir) {
      query += ` AND r.id != $4`;
      params.push(reservaIdExcluir);
    }
    
    query += ` ORDER BY r.hora`;
    
    const result = await pool.query(query, params);
    const reservasExistentes = result.rows;
    
    if (esMesa3) {
      console.log(`   📊 Reservas existentes en mesa 3: ${reservasExistentes.length}`);
    }
    
    const conflictos = [];
    
    // Verificar cada reserva existente
    for (const reserva of reservasExistentes) {
      if (haySolapamiento(hora, duracion, reserva.hora, reserva.duracion)) {
        const conflicto = {
          codigo: reserva.codigo_reserva,
          hora_inicio: reserva.hora,
          hora_fin: formatearMinutos(
            parseInt(reserva.hora.split(':')[0]) * 60 + 
            parseInt(reserva.hora.split(':')[1]) + 
            reserva.duracion
          ),
          cliente: reserva.cliente_nombre,
          origen: reserva.origen
        };
        
        conflictos.push(conflicto);
        
        if (esMesa3) {
          console.log(`   ❌ [MESA 3] Conflicto con reserva ${conflicto.codigo}: ${conflicto.hora_inicio}-${conflicto.hora_fin}`);
        }
      }
    }
    
    // Verificación adicional: reservas en curso (si es para hoy)
    const hoy = new Date().toISOString().split('T')[0];
    if (fecha === hoy) {
      const ahora = new Date();
      const horaActual = ahora.getHours() * 60 + ahora.getMinutes();
      const [horaRes, minRes] = hora.split(':').map(Number);
      const minutosReserva = horaRes * 60 + minRes;
      
      // Verificar reservas actualmente en curso
      const reservasEnCurso = await pool.query(`
        SELECT 
          r.codigo_reserva,
          r.hora,
          COALESCE(r.duracion, $3) as duracion
        FROM reservas r
        WHERE r.mesa_id = $1
          AND r.fecha = $2
          AND r.estado = 'confirmada'
          AND NOW()::TIME BETWEEN r.hora 
          AND (r.hora + COALESCE(r.duracion, $3) * INTERVAL '1 minute')
      `, [mesaId, fecha, duracionPorDefecto]);
      
      if (reservasEnCurso.rows.length > 0) {
        const reservaActiva = reservasEnCurso.rows[0];
        const finReservaActiva = parseInt(reservaActiva.hora.split(':')[0]) * 60 + 
                                parseInt(reservaActiva.hora.split(':')[1]) + 
                                reservaActiva.duracion;
        
        if (minutosReserva < finReservaActiva) {
          conflictos.push({
            codigo: reservaActiva.codigo_reserva,
            hora_inicio: reservaActiva.hora,
            hora_fin: formatearMinutos(finReservaActiva),
            cliente: 'EN CURSO AHORA',
            origen: 'activa'
          });
          
          if (esMesa3) {
            console.log(`   ⚠️ [MESA 3] Mesa actualmente ocupada hasta ${formatearMinutos(finReservaActiva)}`);
          }
        }
      }
    }
    
    // Resultado de la validación
    const valido = conflictos.length === 0;
    let mensaje = '';
    
    if (!valido) {
      if (esMesa3) {
        mensaje = `Mesa 3 no disponible (${conflictos.length} conflicto${conflictos.length > 1 ? 's' : ''}). `;
      } else {
        mensaje = `Mesa ${mesaId} no disponible. `;
      }
      
      const primerConflicto = conflictos[0];
      mensaje += `Conflicto con reserva ${primerConflicto.codigo} (${primerConflicto.hora_inicio}-${primerConflicto.hora_fin})`;
    } else {
      if (esMesa3) {
        console.log(`   ✅ [MESA 3] Sin conflictos - Mesa disponible`);
      }
      mensaje = `Mesa ${mesaId} disponible`;
    }
    
    return {
      valido,
      conflictos,
      mensaje,
      mesa_id: mesaId,
      es_mesa_3: esMesa3
    };
    
  } catch (error) {
    console.error(`❌ Error verificando solapamiento:`, error);
    
    // En caso de error, ser conservador y rechazar
    return {
      valido: false,
      conflictos: [],
      mensaje: 'Error al verificar disponibilidad. Por seguridad, no se puede confirmar la reserva.',
      mesa_id: mesaId,
      es_mesa_3: esMesa3,
      error: error.message
    };
  }
}

/**
 * Busca mesas disponibles sin solapamiento
 * @param {Pool} pool - Pool de conexiones
 * @param {string} fecha - Fecha de la reserva
 * @param {string} hora - Hora de inicio
 * @param {number} personas - Número de personas
 * @param {number} duracion - Duración en minutos
 * @param {number} duracionPorDefecto - Duración por defecto cuando no está especificada
 * @returns {Promise<Array>} Lista de mesas disponibles
 */
async function buscarMesasDisponibles(pool, fecha, hora, personas, duracion, duracionPorDefecto = 120) {
  try {
    const timestamp = new Date().toISOString();
    console.log(`\n🔍 [BUSCAR MESAS ${timestamp}] Buscando para ${fecha} ${hora} (${personas} personas, ${duracion} min)`);
    console.log(`📊 [BUSCAR MESAS] Usando duracionPorDefecto ACTUALIZADA: ${duracionPorDefecto} min`);
    
    // Primero obtener todas las mesas candidatas
    const mesasCandidatas = await pool.query(`
      SELECT id, numero_mesa, capacidad, zona
      FROM mesas
      WHERE capacidad >= $1
        AND capacidad <= $1 + 2
        AND activa = true
      ORDER BY capacidad, numero_mesa
    `, [personas]);
    
    console.log(`   📊 Mesas candidatas: ${mesasCandidatas.rows.length}`);
    
    const mesasDisponibles = [];
    
    // Verificar cada mesa candidata
    for (const mesa of mesasCandidatas.rows) {
      const validacion = await verificarSolapamiento(pool, mesa.id, fecha, hora, duracion, null, duracionPorDefecto);
      
      if (validacion.valido) {
        mesasDisponibles.push({
          ...mesa,
          disponible: true,
          mensaje: validacion.mensaje
        });
        
        // Log especial si mesa 3 está disponible
        if (mesa.id === 3) {
          console.log(`   ✅ [MESA 3] DISPONIBLE para esta reserva`);
        }
      } else {
        // Log especial si mesa 3 NO está disponible
        if (mesa.id === 3) {
          console.log(`   ❌ [MESA 3] NO DISPONIBLE - ${validacion.conflictos.length} conflictos`);
        }
      }
    }
    
    console.log(`   ✅ Mesas disponibles: ${mesasDisponibles.length}`);
    
    return mesasDisponibles;
    
  } catch (error) {
    console.error('❌ Error buscando mesas disponibles:', error);
    return [];
  }
}

/**
 * Encuentra horarios alternativos sin solapamiento
 * MEJORADO: Detecta el momento exacto cuando se liberan las mesas
 * @param {Pool} pool - Pool de conexiones
 * @param {number} mesaId - ID de la mesa específica (opcional)
 * @param {string} fecha - Fecha de la reserva
 * @param {string} horaOriginal - Hora originalmente solicitada
 * @param {number} personas - Número de personas
 * @param {number} duracion - Duración en minutos
 * @param {object} horarioRestaurante - Horario de apertura/cierre
 * @param {number} duracionPorDefecto - Duración por defecto cuando no está especificada
 * @returns {Promise<Array>} Lista de horarios alternativos
 */
async function buscarHorariosAlternativos(pool, mesaId, fecha, horaOriginal, personas, duracion, horarioRestaurante, duracionPorDefecto = 120) {
  try {
    const timestamp = new Date().toISOString();
    console.log(`\n🔍 [ALTERNATIVAS ${timestamp}] Iniciando búsqueda de horarios alternativos`);
    console.log(`📊 [ALTERNATIVAS] Usando duracionPorDefecto ACTUALIZADA: ${duracionPorDefecto} min`);
    console.log(`📊 [ALTERNATIVAS] Hora solicitada: ${horaOriginal}, Duración: ${duracion} min`);
    
    const alternativas = [];
    const [horaOrig, minOrig] = horaOriginal.split(':').map(Number);
    const minutosOriginal = horaOrig * 60 + minOrig;
    
    // CRÍTICO: Primero verificar si hay disponibilidad EXACTA a la hora solicitada
    console.log(`   🎯 [VERIFICACIÓN EXACTA] Verificando disponibilidad exacta a las ${horaOriginal}...`);
    
    let disponibilidadExacta = 0;
    if (mesaId) {
      // Verificar mesa específica a la hora exacta
      const validacionExacta = await verificarSolapamiento(pool, mesaId, fecha, horaOriginal, duracion, null, duracionPorDefecto);
      disponibilidadExacta = validacionExacta.valido ? 1 : 0;
    } else {
      // Buscar cualquier mesa a la hora exacta
      const mesasExactas = await buscarMesasDisponibles(pool, fecha, horaOriginal, personas, duracion, duracionPorDefecto);
      disponibilidadExacta = mesasExactas.length;
    }
    
    if (disponibilidadExacta > 0) {
      console.log(`   ✅ [EXACTA] ¡HAY DISPONIBILIDAD EXACTA a las ${horaOriginal}! (${disponibilidadExacta} mesa(s))`);
      // Agregar la hora exacta como primera alternativa con prioridad máxima
      alternativas.push({
        hora: horaOriginal,
        mesas_disponibles: disponibilidadExacta,
        diferencia_minutos: 0,
        es_horario_cercano: true,
        es_liberacion_mesa: false,
        es_hora_exacta: true,
        mensaje_liberacion: `Disponibilidad confirmada a las ${horaOriginal}`
      });
    }
    
    // NUEVO: Detectar los momentos exactos cuando se liberan las mesas
    const horariosLiberacion = await detectarHorariosLiberacionMesas(
      pool, fecha, minutosOriginal, personas, duracion, duracionPorDefecto, mesaId
    );
    
    // Agregar horarios de liberación como alternativas prioritarias
    for (const liberacion of horariosLiberacion) {
      const diferenciaTiempo = Math.abs(liberacion.minutos - minutosOriginal);
      
      // Incluir liberaciones exactas o posteriores a la hora solicitada
      if (liberacion.minutos >= minutosOriginal) {
        // No duplicar si ya agregamos la hora exacta
        if (liberacion.hora === horaOriginal && disponibilidadExacta > 0) {
          console.log(`   🔄 [LIBERACIÓN] Mesa se libera exactamente a las ${horaOriginal} (ya incluida)`);
          continue;
        }
        
        alternativas.push({
          hora: liberacion.hora,
          mesas_disponibles: liberacion.mesas_liberadas,
          diferencia_minutos: diferenciaTiempo,
          es_horario_cercano: true,
          es_liberacion_mesa: true,
          es_hora_exacta: diferenciaTiempo === 0,
          mensaje_liberacion: diferenciaTiempo === 0 
            ? `Mesa se libera exactamente a las ${liberacion.hora}` 
            : `Mesa se libera a las ${liberacion.hora}`
        });
        
        console.log(`   🔓 [LIBERACIÓN] Mesa(s) se liberan a las ${liberacion.hora} (${liberacion.mesas_liberadas} mesa(s))`);
      }
    }
    
    // Rango de búsqueda para otros horarios: ±3 horas
    const rangoMinutos = 180;
    const desde = Math.max(minutosOriginal - rangoMinutos, 8 * 60); // No antes de las 8:00
    const hasta = Math.min(minutosOriginal + rangoMinutos, 23 * 60); // No después de las 23:00
    
    console.log(`🔍 [ALTERNATIVAS] Buscando horarios adicionales ${formatearMinutos(desde)}-${formatearMinutos(hasta)}`);
    
    // Buscar slots adicionales cada 15 minutos
    for (let minutos = desde; minutos <= hasta; minutos += 15) {
      const horaAlternativa = formatearMinutos(minutos);
      
      // Saltar si ya está en la lista de liberación
      if (alternativas.some(a => a.hora === horaAlternativa)) continue;
      
      // Saltar la hora original
      if (horaAlternativa === horaOriginal) continue;
      
      // Para hoy, verificar que sea futuro
      const hoy = new Date().toISOString().split('T')[0];
      if (fecha === hoy) {
        const ahora = new Date();
        const minutosActuales = ahora.getHours() * 60 + ahora.getMinutes();
        if (minutos <= minutosActuales + 30) continue; // Necesita 30 min de anticipación
      }
      
      const diferenciaTiempo = Math.abs(minutos - minutosOriginal);
      
      // Buscar mesas disponibles en este horario
      let mesasDisponibles;
      
      if (mesaId) {
        // Verificar mesa específica
        const validacion = await verificarSolapamiento(pool, mesaId, fecha, horaAlternativa, duracion, null, duracionPorDefecto);
        mesasDisponibles = validacion.valido ? 1 : 0;
      } else {
        // Buscar cualquier mesa
        const mesas = await buscarMesasDisponibles(pool, fecha, horaAlternativa, personas, duracion, duracionPorDefecto);
        mesasDisponibles = mesas.length;
      }
      
      if (mesasDisponibles > 0) {
        alternativas.push({
          hora: horaAlternativa,
          mesas_disponibles: mesasDisponibles,
          diferencia_minutos: diferenciaTiempo,
          es_horario_cercano: diferenciaTiempo <= 60,
          es_liberacion_mesa: false
        });
      }
    }
    
    // Ordenar con prioridad especial para hora exacta y horarios de liberación
    alternativas.sort((a, b) => {
      // MÁXIMA PRIORIDAD: hora exacta solicitada
      if (a.es_hora_exacta && !b.es_hora_exacta) return -1;
      if (!a.es_hora_exacta && b.es_hora_exacta) return 1;
      
      // Segunda prioridad: horarios de liberación de mesa
      if (a.es_liberacion_mesa && !b.es_liberacion_mesa) return -1;
      if (!a.es_liberacion_mesa && b.es_liberacion_mesa) return 1;
      
      // Tercera prioridad: horarios muy cercanos (dentro de 1 hora)
      if (a.es_horario_cercano && !b.es_horario_cercano) return -1;
      if (!a.es_horario_cercano && b.es_horario_cercano) return 1;
      
      // Cuarta prioridad: ordenar por diferencia de tiempo
      return a.diferencia_minutos - b.diferencia_minutos;
    });
    
    console.log(`   ✅ Encontradas ${alternativas.length} alternativas`);
    if (alternativas.length > 0) {
      const primeras = alternativas.slice(0, 3);
      console.log(`   📋 Primeras alternativas:`, primeras.map(a => {
        const tipo = a.es_liberacion_mesa ? '[LIBERACIÓN]' : '';
        return `${a.hora} ${tipo} (${a.diferencia_minutos} min)`;
      }).join(', '));
    }
    
    return alternativas.slice(0, 5); // Máximo 5 alternativas
    
  } catch (error) {
    console.error('❌ Error buscando horarios alternativos:', error);
    return [];
  }
}

/**
 * Detecta los momentos exactos cuando se liberan las mesas
 * @private
 */
async function detectarHorariosLiberacionMesas(pool, fecha, minutosOriginal, personas, duracion, duracionPorDefecto, mesaId = null) {
  try {
    console.log(`   🔍 [LIBERACIÓN] Detectando horarios cuando se liberan mesas...`);
    console.log(`   📊 [LIBERACIÓN] Hora solicitada: ${formatearMinutos(minutosOriginal)} (${minutosOriginal} minutos)`);
    
    // IMPORTANTE: Usar la duración REAL de cada reserva, no la duración por defecto para COALESCE
    // Esto asegura que detectamos correctamente cuándo se libera cada mesa
    let query;
    let params;
    
    if (mesaId) {
      // Buscar liberación de una mesa específica
      query = `
        SELECT 
          r.hora,
          r.duracion as duracion_original,
          COALESCE(r.duracion, $2) as duracion,
          m.id as mesa_id,
          m.numero_mesa,
          m.capacidad
        FROM reservas r
        JOIN mesas m ON r.mesa_id = m.id
        WHERE r.fecha = $1
          AND r.estado IN ('confirmada', 'pendiente')
          AND m.id = $3
        ORDER BY r.hora
      `;
      params = [fecha, duracionPorDefecto, mesaId];
    } else {
      // Buscar liberación de cualquier mesa adecuada
      query = `
        SELECT 
          r.hora,
          r.duracion as duracion_original,
          COALESCE(r.duracion, $2) as duracion,
          m.id as mesa_id,
          m.numero_mesa,
          m.capacidad
        FROM reservas r
        JOIN mesas m ON r.mesa_id = m.id
        WHERE r.fecha = $1
          AND r.estado IN ('confirmada', 'pendiente')
          AND m.capacidad >= $3
          AND m.capacidad <= $3 + 2
          AND m.activa = true
        ORDER BY r.hora
      `;
      params = [fecha, duracionPorDefecto, personas];
    }
    
    const result = await pool.query(query, params);
    const reservasExistentes = result.rows;
    
    const horariosLiberacion = [];
    const mesasLiberadas = new Map(); // Para rastrear cuándo se libera cada mesa
    
    // Calcular cuándo se libera cada mesa
    for (const reserva of reservasExistentes) {
      const [h, m] = reserva.hora.split(':').map(Number);
      const minutosInicio = h * 60 + m;
      const minutosFin = minutosInicio + reserva.duracion;
      
      // CRÍTICO: Incluir SIEMPRE si coincide exactamente con la hora solicitada
      const diferenciaMinutos = Math.abs(minutosFin - minutosOriginal);
      const esLiberacionExacta = minutosFin === minutosOriginal;
      
      // Incluir si:
      // 1. Se libera EXACTAMENTE a la hora solicitada (prioridad máxima)
      // 2. Se libera cerca del horario solicitado (±2 horas)
      if (esLiberacionExacta || diferenciaMinutos <= 120) {
        const horaLiberacion = formatearMinutos(minutosFin);
        
        if (esLiberacionExacta) {
          console.log(`   🎯 [LIBERACIÓN EXACTA] Mesa ${reserva.numero_mesa} se libera EXACTAMENTE a las ${horaLiberacion}!`);
          console.log(`      Reserva actual: ${reserva.hora} con duración ${reserva.duracion} min`);
        }
        
        // Agrupar por hora de liberación
        if (!mesasLiberadas.has(horaLiberacion)) {
          mesasLiberadas.set(horaLiberacion, {
            hora: horaLiberacion,
            minutos: minutosFin,
            mesas: [],
            es_exacta: esLiberacionExacta
          });
        }
        
        mesasLiberadas.get(horaLiberacion).mesas.push({
          mesa_id: reserva.mesa_id,
          numero_mesa: reserva.numero_mesa,
          capacidad: reserva.capacidad,
          hora_inicio_reserva: reserva.hora,
          duracion_reserva: reserva.duracion
        });
      }
    }
    
    // Convertir a array y filtrar
    for (const [hora, info] of mesasLiberadas) {
      // Verificar que al menos una mesa sea adecuada para el número de personas
      const mesasAdecuadas = info.mesas.filter(m => 
        m.capacidad >= personas && m.capacidad <= personas + 2
      );
      
      if (mesasAdecuadas.length > 0) {
        horariosLiberacion.push({
          hora: info.hora,
          minutos: info.minutos,
          mesas_liberadas: mesasAdecuadas.length,
          mesas_info: mesasAdecuadas
        });
      }
    }
    
    // Ordenar por cercanía al horario solicitado
    horariosLiberacion.sort((a, b) => 
      Math.abs(a.minutos - minutosOriginal) - Math.abs(b.minutos - minutosOriginal)
    );
    
    console.log(`   📊 [LIBERACIÓN] Detectados ${horariosLiberacion.length} horarios de liberación`);
    
    return horariosLiberacion;
    
  } catch (error) {
    console.error('❌ Error detectando horarios de liberación:', error);
    return [];
  }
}

module.exports = {
  verificarSolapamiento,
  buscarMesasDisponibles,
  buscarHorariosAlternativos,
  haySolapamiento
};