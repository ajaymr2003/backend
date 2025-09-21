// /backend/public/js/vehicle_simulator.js

const apiUrl = '/api';
let userEmail = null;

// --- State Variables ---
let statusInterval = null;
let animationInterval = null;
let locationUpdateInterval = null;
let currentIndex = 0; // Tracks the vehicle's position along the route

// --- Map Layers ---
let map = null;
let userMarker = null;
let destinationMarker = null;
let vehicleMarker = null;
let routeLine = null;
let routeData = null;

const defaultCenter = [12.9716, 77.5946];

// --- Get all UI elements ---
const userSelect = document.getElementById('userSelect');
const initialBatterySelect = document.getElementById('initialBatterySelect');
const drainRateSelect = document.getElementById('drainRateSelect');
const vehicleSpeedSelect = document.getElementById('vehicleSpeedSelect');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const resetButton = document.getElementById('resetButton');
const mapInstruction = document.getElementById('mapInstruction');
const currentUserElem = document.getElementById('currentUser');
const runningStatusElem = document.getElementById('runningStatus');
const batteryLevelElem = document.getElementById('batteryLevel');
const routeInfoElem = document.getElementById('routeInfo');
const routeDistanceElem = document.getElementById('routeDistance');
const routeTimeElem = document.getElementById('routeTime');


// --- Event Listeners ---
userSelect.addEventListener('change', () => {
    userEmail = userSelect.value;
    if (userEmail) {
        if (statusInterval) clearInterval(statusInterval);
        if (animationInterval) clearInterval(animationInterval);
        if (locationUpdateInterval) clearInterval(locationUpdateInterval);
        if (userMarker) { userMarker.remove(); userMarker = null; }
        if (destinationMarker) { destinationMarker.remove(); destinationMarker = null; }
        if (vehicleMarker) { vehicleMarker.remove(); vehicleMarker = null; }
        if (routeLine) { routeLine.remove(); routeLine = null; }
        routeData = null;
        currentIndex = 0;
        currentUserElem.textContent = userEmail;
        resetButton.disabled = false;
        routeInfoElem.style.display = 'none';
        startPolling(true);
    }
});
startButton.addEventListener('click', async () => {
    if (!routeData) {
        alert("Please set a valid start and destination point on the map.");
        return;
    }
    await callApi('/start', {
        email: userEmail,
        initialBattery: initialBatterySelect.value,
        drainRate: drainRateSelect.value
    });
    startMovementSimulation(routeData);
});
stopButton.addEventListener('click', () => {
    callApi('/stop', { email: userEmail });
    stopMovementSimulation();
});
resetButton.addEventListener('click', () => {
    callApi('/reset', { email: userEmail });
    resetSimulationState();
});
// MODIFIED: This listener now also handles live speed changes.
vehicleSpeedSelect.addEventListener('change', () => {
    displayRouteInfo(); // Always update time estimate
    // If the animation is currently running, reschedule it with the new speed
    if (animationInterval) {
        scheduleAnimation();
    }
});
// NEW: Listener for live drain rate changes.
drainRateSelect.addEventListener('change', () => {
    // If the simulation is running, send the update to the backend
    if (userEmail && runningStatusElem.classList.contains('running')) {
        callApi('/update-drain-rate', {
            email: userEmail,
            drainRate: drainRateSelect.value
        });
    }
});


// --- Core Functions ---
// MODIFIED: This function now allows drain rate and speed to be changed during a run.
function updateControlsState(isRunning) {
    userSelect.disabled = isRunning;
    initialBatterySelect.disabled = isRunning;
    // Drain rate and speed can now be changed live
    drainRateSelect.disabled = false;
    vehicleSpeedSelect.disabled = false;
    resetButton.disabled = isRunning;
    startButton.disabled = isRunning || !routeData;
    stopButton.disabled = !isRunning;
}
async function fetchRoute(startLatLng, endLatLng) {
    const url = `https://router.project-osrm.org/route/v1/driving/${startLatLng.lng},${startLatLng.lat};${endLatLng.lng},${endLatLng.lat}?geometries=geojson`;
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`OSRM responded with status ${response.status}`);
        const data = await response.json();
        if (data.routes && data.routes.length > 0) {
            const route = data.routes[0];
            return {
                coordinates: route.geometry.coordinates.map(coord => [coord[1], coord[0]]),
                distance: route.distance
            };
        }
        return null;
    } catch (error) {
        console.error("Error fetching route from OSRM:", error);
        alert("Could not fetch a route. Please try different points.");
        return null;
    }
}
function displayRouteInfo() {
    if (!routeData) return;
    const distanceKm = (routeData.distance / 1000).toFixed(2);
    const speedKmh = parseInt(vehicleSpeedSelect.value, 10);
    const timeHours = speedKmh > 0 ? distanceKm / speedKmh : 0;
    const timeMinutes = Math.round(timeHours * 60);
    routeDistanceElem.textContent = distanceKm;
    routeTimeElem.textContent = `${timeMinutes} min`;
    routeInfoElem.style.display = 'block';
}

// NEW: This function contains only the animation logic, making it reusable.
function scheduleAnimation() {
    if (animationInterval) clearInterval(animationInterval); // Stop any previous animation

    const routeCoordinates = routeData.coordinates;
    const distanceMeters = routeData.distance;
    const speedKmh = parseInt(vehicleSpeedSelect.value, 10);
    const speedMps = speedKmh * 1000 / 3600;

    // Calculate total duration based on the *entire* route to keep timing consistent
    const totalDurationSeconds = speedKmh > 0 ? distanceMeters / speedMps : Infinity;
    const stepInterval = (totalDurationSeconds / routeCoordinates.length) * 1000;

    animationInterval = setInterval(() => {
        if (currentIndex >= routeCoordinates.length) {
            callApi('/stop', { email: userEmail });
            stopMovementSimulation();
            return;
        }
        if (vehicleMarker) {
            vehicleMarker.setLatLng(routeCoordinates[currentIndex]);
        }
        currentIndex++;
    }, stepInterval);

    console.log(`Animation (re)scheduled. Steps: ${routeCoordinates.length}, Interval: ${stepInterval.toFixed(2)} ms`);
}

// MODIFIED: This function now sets up the map and calls scheduleAnimation.
function startMovementSimulation() {
    if (userMarker) { userMarker.remove(); userMarker = null; }
    if (destinationMarker) { destinationMarker.remove(); destinationMarker = null; }
    if (routeLine) routeLine.remove();
    
    currentIndex = 0; // Reset position to the start of the route
    const routeCoordinates = routeData.coordinates;
    routeLine = L.polyline(routeCoordinates, { color: '#007bff', weight: 5 }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [50, 50] });

    const carIcon = L.icon({
        iconUrl: 'https://cdn-icons-png.flaticon.com/512/3039/3039898.png',
        iconSize: [38, 38], iconAnchor: [19, 38]
    });
    vehicleMarker = L.marker(routeCoordinates[0], { icon: carIcon }).addTo(map);

    scheduleAnimation(); // Start the animation loop

    if (locationUpdateInterval) clearInterval(locationUpdateInterval);
    locationUpdateInterval = setInterval(() => {
        if (vehicleMarker) {
            const { lat, lng } = vehicleMarker.getLatLng();
            updateVehicleLocation(lat, lng);
        }
    }, 1500);
}
async function onMapClick(e) {
    if (!userEmail) { alert("Please select a user first."); return; }
    if (runningStatusElem.classList.contains('running')) return;
    const { lat, lng } = e.latlng;
    if (!userMarker) {
        createOrUpdateStartMarker([lat, lng]);
        updateVehicleLocation(lat, lng);
        mapInstruction.innerHTML = "Click map to set the <strong>Destination Point</strong>.";
    } else {
        createOrUpdateDestinationMarker([lat, lng]);
        if (routeLine) { routeLine.remove(); routeLine = null; }
        routeData = await fetchRoute(userMarker.getLatLng(), destinationMarker.getLatLng());
        if (routeData) {
            routeLine = L.polyline(routeData.coordinates, { color: '#007bff', weight: 5, dashArray: '10, 5' }).addTo(map);
            map.fitBounds(routeLine.getBounds(), { padding: [50, 50] });
            displayRouteInfo();
            mapInstruction.innerHTML = "Route is set. You can now <strong>Start Ride</strong>.";
        } else {
            routeInfoElem.style.display = 'none';
            if(destinationMarker) { destinationMarker.remove(); destinationMarker = null; }
            mapInstruction.innerHTML = "Could not find a route. Please set a new <strong>Destination Point</strong>.";
        }
    }
    updateControlsState(false);
}
function resetSimulationState() {
    stopMovementSimulation();
    if (userMarker) { userMarker.remove(); userMarker = null; }
    if (destinationMarker) { destinationMarker.remove(); destinationMarker = null; }
    if (routeLine) { routeLine.remove(); routeLine = null; }
    routeData = null;
    routeInfoElem.style.display = 'none';
    mapInstruction.innerHTML = "Click map to set vehicle's <strong>Start Point</strong>.";
    getStatus();
}

const getStatus = (isInitialSetup = false) => {
    if (!userEmail) return;
    fetch(`${apiUrl}/status?email=${encodeURIComponent(userEmail)}`)
        .then(res => res.json())
        .then(data => {
            const isRunning = data.isRunning;
            runningStatusElem.textContent = isRunning ? 'Running' : 'Not Running';
            runningStatusElem.className = isRunning ? 'running' : 'stopped';
            batteryLevelElem.textContent = `${data.batteryLevel} %`;
            updateControlsState(isRunning);
            if (!isRunning && vehicleMarker) {
                stopMovementSimulation();
            }
            if (isInitialSetup) {
                if (data.latitude != null && data.longitude != null) {
                    const vehiclePosition = [data.latitude, data.longitude];
                    createOrUpdateStartMarker(vehiclePosition);
                    map.setView(vehiclePosition, 15);
                    mapInstruction.innerHTML = "Vehicle location loaded. Click map to set the <strong>Destination Point</strong>.";
                } else {
                    mapInstruction.innerHTML = "Click map to set vehicle's <strong>Start Point</strong>.";
                }
            }
        })
        .catch(console.error);
};

function startPolling(isInitial = false) {
    if (statusInterval) clearInterval(statusInterval);
    getStatus(isInitial); 
    statusInterval = setInterval(() => getStatus(false), 2000);
}
function stopMovementSimulation() {
    if (animationInterval) clearInterval(animationInterval);
    if (locationUpdateInterval) clearInterval(locationUpdateInterval);
    animationInterval = null;
    locationUpdateInterval = null;
    currentIndex = 0; // Reset route position
    if (vehicleMarker) {
        const lastPosition = vehicleMarker.getLatLng();
        vehicleMarker.remove();
        vehicleMarker = null;
        createOrUpdateStartMarker(lastPosition);
    }
    getStatus();
}
function initMap() {
    map = L.map('map').setView(defaultCenter, 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    map.on('click', onMapClick);
}
function createOrUpdateStartMarker(latlng) {
    const carIcon = L.icon({
        iconUrl: 'https://cdn-icons-png.flaticon.com/512/6274/6274953.png',
        iconSize: [38, 38], iconAnchor: [19, 38]
    });
    if (userMarker) {
        userMarker.setLatLng(latlng);
    } else {
        userMarker = L.marker(latlng, { icon: carIcon, draggable: true }).addTo(map);
        userMarker.on('dragend', async (event) => {
            if (runningStatusElem.classList.contains('running')) return;
            if (destinationMarker) {
                onMapClick({ latlng: destinationMarker.getLatLng() });
            }
        });
    }
}
function createOrUpdateDestinationMarker(latlng) {
    const flagIcon = L.icon({
        iconUrl: 'https://cdn-icons-png.flaticon.com/512/157/157233.png',
        iconSize: [38, 38], iconAnchor: [1, 38]
    });
    if (destinationMarker) {
        destinationMarker.setLatLng(latlng);
    } else {
        destinationMarker = L.marker(latlng, { icon: flagIcon, draggable: true }).addTo(map);
        destinationMarker.on('dragend', (event) => {
            onMapClick({ latlng: event.target.getLatLng() });
        });
    }
}
async function callApi(endpoint, body) {
    try {
        const response = await fetch(apiUrl + endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || `API call to ${endpoint} failed`);
        }
        const data = await response.json();
        console.log(`API call to ${endpoint} successful:`, data);
        if (endpoint !== '/start') { // Avoid double-calling getStatus on start
             getStatus();
        }
        return data;
    } catch (error) {
        console.error(`API Error on ${endpoint}:`, error);
        alert(`Error: ${error.message}`);
    }
}
async function fetchAndDisplayStations() {
    try {
        const res = await fetch(`${apiUrl}/stations`);
        const data = await res.json();
        const stations = Array.isArray(data.stations) ? data.stations : [];
        const stationIcon = L.icon({
            iconUrl: 'https://cdn-icons-png.flaticon.com/512/3448/3448603.png',
            iconSize: [32, 32],
            iconAnchor: [16, 32]
        });
        const stationPositions = [];
        stations.forEach(station => {
            if (station.latitude && station.longitude) {
                const position = [station.latitude, station.longitude];
                L.marker(position, { icon: stationIcon })
                    .addTo(map)
                    .bindPopup(`<b>${station.name}</b>`);
                stationPositions.push(position);
            }
        });
        if (stationPositions.length > 0) {
            const bounds = L.latLngBounds(stationPositions);
            map.fitBounds(bounds, { padding: [50, 50] });
        }
    } catch (error) {
        console.error('Failed to load stations for map:', error);
    }
}
async function updateVehicleLocation(latitude, longitude) {
    if (!userEmail) return;
    await callApi('/update-location', {
        email: userEmail,
        latitude,
        longitude
    });
}
async function initialize() {
    initMap();
    await fetchAndDisplayStations();
    try {
        const userRes = await fetch(`${apiUrl}/users`);
        const userData = await userRes.json();
        userSelect.innerHTML = '<option value="" disabled selected>Select a User</option>';
        (userData.users || []).forEach(email => {
            const option = document.createElement('option');
            option.value = email;
            option.textContent = email;
            userSelect.appendChild(option);
        });
    } catch (error) {
        console.error('Failed to load users:', error);
    }
    mapInstruction.innerHTML = "Select a user to begin.";
    updateControlsState(false);
}
initialize();