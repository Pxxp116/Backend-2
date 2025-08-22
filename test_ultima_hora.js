// Test para validar el cálculo de la última hora de entrada
// después de las correcciones al sistema de horarios

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
 * Simula el cálculo de última hora de entrada
 */
function calcularUltimaHora(horaApertura, horaCierre, duracionReserva) {
  console.log(`\n🧪 PRUEBA: ${horaApertura} - ${horaCierre}, duración: ${duracionReserva}min`);
  
  const [horaAp, minAp] = horaApertura.split(':').map(Number);
  const [horaCi, minCi] = horaCierre.split(':').map(Number);
  
  const minutosApertura = horaAp * 60 + minAp;
  let minutosCierre = horaCi * 60 + minCi;
  
  // Manejar horarios que cruzan medianoche
  if (minutosCierre <= minutosApertura) {
    minutosCierre += 1440; // Añadir 24 horas
    console.log(`   ⚠️ Horario cruza medianoche. Cierre ajustado: ${minutosCierre} min`);
  }
  
  const minutosUltimaEntrada = minutosCierre - duracionReserva;
  const horaUltimaEntrada = formatearMinutosAHora(minutosUltimaEntrada);
  const tiempoDisponible = minutosCierre - minutosApertura;
  
  console.log(`   📊 Apertura: ${minutosApertura} min (${horaApertura})`);
  console.log(`   📊 Cierre: ${minutosCierre} min (${formatearMinutosAHora(minutosCierre)})`);
  console.log(`   📊 Tiempo disponible: ${tiempoDisponible} min`);
  console.log(`   📊 Última entrada: ${minutosUltimaEntrada} min (${horaUltimaEntrada})`);
  
  // Validaciones
  if (minutosUltimaEntrada < minutosApertura && tiempoDisponible < duracionReserva) {
    console.log(`   ❌ PROBLEMA: No hay suficiente tiempo (necesita ${duracionReserva}min, disponible ${tiempoDisponible}min)`);
    return { valido: false, motivo: 'Tiempo insuficiente' };
  }
  
  console.log(`   ✅ VÁLIDO: Última hora de entrada: ${horaUltimaEntrada}`);
  return { valido: true, ultima_hora: horaUltimaEntrada };
}

// Casos de prueba
console.log('🔬 TESTING: Cálculo de última hora de entrada');
console.log('=========================================');

// Caso 1: Horario normal diurno
calcularUltimaHora('13:00', '23:00', 120); // Esperado: 21:00

// Caso 2: Horario que cruza medianoche
calcularUltimaHora('18:00', '02:00', 120); // Esperado: 00:00

// Caso 3: Horario nocturno que cruza medianoche
calcularUltimaHora('20:00', '04:00', 150); // Esperado: 01:30

// Caso 4: Horario muy corto
calcularUltimaHora('23:00', '01:00', 120); // Esperado: 23:00 (problema)

// Caso 5: Horario normal con duración corta
calcularUltimaHora('12:00', '22:00', 90); // Esperado: 20:30

// Caso 6: Caso problemático - duración mayor que tiempo disponible
calcularUltimaHora('23:30', '01:00', 180); // Esperado: Error, no suficiente tiempo

console.log('\n✅ Pruebas completadas');