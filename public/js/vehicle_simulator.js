const apiUrl = '/api';
let userEmail = null;
let statusInterval = null;
let simulationLocationInterval = null; 

let map = null;
let userMarker = null; 
let animatedMarker = null;
let routeLine = null;
let stations = []; 
let defaultCenter = [12.9716, 77.5946];

const userSelect = document.getElementById('userSelect');
const initialBatterySelect = document.getElementById('initialBatterySelect');
const drainRateSelect = document.getElementById('drainRateSelect');
const vehicleSpeedSelect = document.getElementById('vehicleSpeedSelect'); // New speed control
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const resetButton = document.getElementById('resetButton');
const currentUserElem = document.getElementById('currentUser');
const runningStatusElem = document.getElementById('runningStatus');
const batteryLevelElem = document.getElementById('batteryLevel');
const manualBatterySlider = document.getElementById('manualBatterySlider');
const manualBatteryValue = document.getElementById('manualBatteryValue');

// Speed settings mapping the dropdown value to animation parameters
const speedSettings = {
    slow: { distance: 20, interval: 500 },
    normal: { distance: 70, interval: 500 },
    fast: { distance: 150, interval: 500 },
    ludicrous: { distance: 400, interval: 200 }
};

userSelect.addEventListener('change', () => {
    userEmail = userSelect.value;
    if (userEmail) {
        currentUserElem.textContent = userEmail;
        [startButton, stopButton, resetButton].forEach(btn => btn.disabled = false);
        startPolling();
    }
});

manualBatterySlider.addEventListener('input', () => {
    manualBatteryValue.textContent = `${manualBatterySlider.value}%`;
});

manualBatterySlider.addEventListener('change', () => {
    const newBatteryLevel = parseInt(manualBatterySlider.value, 10);
    callApi('/set-battery', { email: userEmail, batteryLevel: newBatteryLevel });
});

startButton.addEventListener('click', async () => {
    if (!userMarker) {
        alert("Please select a starting location on the map first.");
        return;
    }
    if (stations.length === 0) {
        alert("Station data not loaded yet. Please wait a moment.");
        return;
    }
    const destination = stations[Math.floor(Math.random() * stations.length)];
    const startLatLng = userMarker.getLatLng();
    const endLatLng = L.latLng(destination.latitude, destination.longitude);
    const routeCoordinates = await fetchRoute(startLatLng, endLatLng);
    if (!routeCoordinates) {
        alert("Could not find a route to the destination.");
        return;
    }

    // Get selected speed and find the corresponding animation settings
    const selectedSpeed = vehicleSpeedSelect.value;
    const animationSettings = speedSettings[selectedSpeed] || speedSettings.normal;

    startMovementSimulation(routeCoordinates, animationSettings);

    await callApi('/start', {
        email: userEmail,
        initialBattery: initialBatterySelect.value,
        drainRate: drainRateSelect.value
    });
});

stopButton.addEventListener('click', () => {
    stopMovementSimulation();
    callApi('/stop', { email: userEmail });
});

resetButton.addEventListener('click', () => {
    stopMovementSimulation();
    callApi('/reset', { email: userEmail });
});

const getStatus = () => {
    if (!userEmail) return;
    fetch(`${apiUrl}/status?email=${encodeURIComponent(userEmail)}`)
        .then(res => res.json())
        .then(data => {
            const isRunning = data.isRunning;
            runningStatusElem.textContent = isRunning ? 'Running' : 'Not Running';
            runningStatusElem.className = isRunning ? 'running' : 'stopped';
            batteryLevelElem.textContent = `${data.batteryLevel} %`;

            startButton.disabled = isRunning;
            stopButton.disabled = !isRunning;
            initialBatterySelect.disabled = isRunning;
            drainRateSelect.disabled = isRunning;
            vehicleSpeedSelect.disabled = isRunning; // Disable speed selector when running
            manualBatterySlider.disabled = isRunning;

            if (!isRunning) {
                manualBatterySlider.value = data.batteryLevel;
                manualBatteryValue.textContent = `${data.batteryLevel}%`;
            }

            if (!isRunning && data.latitude && data.longitude) {
                const newPos = [data.latitude, data.longitude];
                if (userMarker) {
                    userMarker.setLatLng(newPos);
                } else {
                    createUserMarker(newPos);
                }
            }
        })
        .catch(console.error);
};

function startPolling() {
    if (statusInterval) clearInterval(statusInterval);
    getStatus();
    statusInterval = setInterval(getStatus, 2000);
}

async function callApi(endpoint, body) {
    try {
        await fetch(`${apiUrl}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    } catch (error) {
        console.error(`Error calling ${endpoint}:`, error);
    }
}

async function fetchRoute(startLatLng, endLatLng) {
    const url = `https://router.project-osrm.org/route/v1/driving/${startLatLng.lng},${startLatLng.lat};${endLatLng.lng},${endLatLng.lat}?geometries=geojson`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.routes && data.routes.length > 0) {
            return data.routes[0].geometry.coordinates.map(coord => [coord[1], coord[0]]);
        }
        return null;
    } catch (error) {
        console.error("Error fetching route from OSRM:", error);
        return null;
    }
}

// Function now accepts animation settings
function startMovementSimulation(routeCoordinates, animationSettings) {
    if (userMarker) {
        userMarker.remove();
        userMarker = null;
    }
    routeLine = L.polyline(routeCoordinates, { color: 'blue' }).addTo(map);
    map.fitBounds(routeLine.getBounds());
    const carIcon = L.icon({
        iconUrl: 'https://cdn-icons-png.flaticon.com/512/3039/3039898.png',
        iconSize: [38, 38], iconAnchor: [19, 38]
    });
    animatedMarker = L.animatedMarker(routeLine.getLatLngs(), {
        icon: carIcon,
        autostart: true,
        distance: animationSettings.distance, 
        interval: animationSettings.interval,
        onEnd: stopMovementSimulation
    });
    map.addLayer(animatedMarker);
    if (simulationLocationInterval) clearInterval(simulationLocationInterval);
    simulationLocationInterval = setInterval(() => {
        if (animatedMarker) {
            const { lat, lng } = animatedMarker.getLatLng();
            updateVehicleLocation(lat, lng);
        }
    }, 1500);
}

function stopMovementSimulation() {
    if (simulationLocationInterval) clearInterval(simulationLocationInterval);
    simulationLocationInterval = null;
    if (animatedMarker) {
        map.removeLayer(animatedMarker);
        animatedMarker = null;
    }
    if (routeLine) {
        map.removeLayer(routeLine);
        routeLine = null;
    }
}

function initMap() {
    map = L.map('map').setView(defaultCenter, 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
    map.on('click', onMapClick);
}

async function fetchStationsForMap() {
    try {
        const res = await fetch(`${apiUrl}/stations`);
        const data = await res.json();
        stations = Array.isArray(data) ? data : data.stations;
        const stationIcon = L.icon({
            iconUrl: 'https://cdn-icons-png.flaticon.com/512/3448/3448603.png',
            iconSize: [32, 32], iconAnchor: [16, 32]
        });
        stations.forEach(station => {
            if (station.latitude && station.longitude) {
                L.marker([station.latitude, station.longitude], { icon: stationIcon })
                    .addTo(map)
                    .bindPopup(`<b>${station.name}</b>`);
            }
        });
    } catch (error) {
        console.error('Failed to load stations for map:', error);
    }
}

function onMapClick(e) {
    if (!userEmail) { alert("Please select a user first."); return; }
    if (runningStatusElem.classList.contains('running')) {
        alert("Cannot change location while the car is running. Please stop the car first.");
        return;
    }
    const { lat, lng } = e.latlng;
    if (userMarker) {
        userMarker.setLatLng(e.latlng);
    } else {
        createUserMarker(e.latlng);
    }
    updateVehicleLocation(lat, lng);
}

function createUserMarker(latlng) {
    const carIcon = L.icon({
        iconUrl: 'https://cdn-icons-png.flaticon.com/512/6274/6274953.png',
        iconSize: [38, 38], iconAnchor: [19, 38]
    });
    userMarker = L.marker(latlng, { icon: carIcon, draggable: true })
        .addTo(map)
        .bindPopup('Vehicle Starting Point');
    userMarker.on('dragend', function(event) {
        const { lat, lng } = event.target.getLatLng();
        updateVehicleLocation(lat, lng);
    });
}

async function updateVehicleLocation(latitude, longitude) {
    if (!userEmail) return;
    await callApi('/update-location', { email: userEmail, latitude, longitude });
}

async function initialize() { 
    initMap();
    try {
        const userRes = await fetch(`${apiUrl}/users`);
        const userData = await userRes.json();
        userSelect.innerHTML = '<option value="" disabled selected>Select a User</option>';
        userData.users.forEach(email => {
            const option = document.createElement('option');
            option.value = email;
            option.textContent = email;
            userSelect.appendChild(option);
        });
        await fetchStationsForMap();
    } catch (error) {
        console.error('Failed to load users:', error);
    }
}

initialize();
