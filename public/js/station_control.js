const apiUrl = '/api';
let stationDataCache = [];
let selectedStationId = null;

const stationListElem = document.getElementById('stationList');
const stationControlsElem = document.getElementById('stationControls');
const selectedStationNameElem = document.getElementById('selectedStationName');
const slotControlsContainer = document.getElementById('slotControlsContainer');
const idealPresetBtn = document.getElementById('idealPresetBtn');
const normalPresetBtn = document.getElementById('normalPresetBtn');
const busyPresetBtn = document.getElementById('busyPresetBtn');
const presetButtons = [idealPresetBtn, normalPresetBtn, busyPresetBtn];

async function callApi(endpoint, body, method = 'POST') {
    try {
        await fetch(`${apiUrl}${endpoint}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    } catch (error) {
        console.error(`Error calling ${endpoint}:`, error);
    }
}

async function fetchStations() {
    try {
        const stationRes = await fetch(`${apiUrl}/stations`);
        const stationData = await stationRes.json();
        let stationsArray = [];
        if (Array.isArray(stationData)) {
            stationsArray = stationData;
        } else if (stationData && Array.isArray(stationData.stations)) {
            stationsArray = stationData.stations;
        }
        stationDataCache = stationsArray.map(s => ({ ...s, slots: s.slots || [] }));
        renderStationList();
    } catch (error) {
        console.error('Failed to load stations:', error);
    }
}

function renderStationList() {
    stationListElem.innerHTML = '';
    if (stationDataCache.length === 0) {
        stationListElem.innerHTML = '<div class="station-item"><div class="station-details">No stations found.</div></div>';
        return;
    }
    stationDataCache.forEach(station => {
        const item = document.createElement('div');
        item.className = 'station-item';
        item.dataset.stationId = station.id;
        const availableCount = station.slots.filter(s => s.isAvailable).length;
        item.innerHTML = `
            <div class="station-details">
                <div class="station-name">${station.name}</div>
                <div class="station-address">${station.address}</div>
                <div class="station-address"><strong>Slots:</strong> ${availableCount} / ${station.slots.length} available</div>
            </div>`;
        item.addEventListener('click', () => selectStation(station.id));
        stationListElem.appendChild(item);
    });
}

function selectStation(stationId) {
    selectedStationId = stationId;
    document.querySelectorAll('.station-item').forEach(el => el.classList.remove('selected'));
    const selectedItem = document.querySelector(`[data-station-id="${stationId}"]`);
    if (selectedItem) {
        selectedItem.classList.add('selected');
    }
    stationControlsElem.classList.add('active');
    renderSlotControls();
}

function renderSlotControls() {
    if (!selectedStationId) return;
    const station = stationDataCache.find(s => s.id === selectedStationId);
    if (!station) return;

    selectedStationNameElem.textContent = station.name;
    slotControlsContainer.innerHTML = '';

    if (station.slots.length === 0) {
        slotControlsContainer.innerHTML = '<div class="slot-item">This station has no configured slots.</div>';
        return;
    }

    station.slots.forEach((slot, index) => {
        const slotId = `slot-${station.id}-${index}`;
        const slotItem = document.createElement('div');
        slotItem.className = 'slot-item';
        const isChecked = slot.isAvailable ? 'checked' : '';
        slotItem.innerHTML = `
            <div class="slot-info">
                Slot ${index + 1} <span>(${slot.chargerType} - ${slot.powerKw}kW)</span>
            </div>
            <label class="switch">
                <input type="checkbox" id="${slotId}" ${isChecked}>
                <span class="slider"></span>
            </label>
        `;
        slotControlsContainer.appendChild(slotItem);
        document.getElementById(slotId).addEventListener('change', (event) => {
            updateSlotStatus(index, event.target.checked);
        });
    });
}

async function updateSlotStatus(slotIndex, newStatus) {
    if (!selectedStationId) return;
    const station = stationDataCache.find(s => s.id === selectedStationId);
    if (!station || slotIndex >= station.slots.length) return;

    station.slots[slotIndex].isAvailable = newStatus;
    renderStationList();
    selectStation(selectedStationId); 
    
    await callApi(`/stations/${selectedStationId}/slot-update`, {
        slotIndex: slotIndex,
        isAvailable: newStatus
    });
}

async function applyPreset(presetLogic) {
    if (stationDataCache.length === 0) return;
    presetButtons.forEach(btn => btn.disabled = true);

    const updates = stationDataCache.map(station => ({
        id: station.id,
        slots: presetLogic(station.slots)
    }));

    await callApi('/stations/bulk-slot-update', { updates });

    stationDataCache.forEach((station, index) => {
        station.slots = updates[index].slots;
    });

    renderStationList();
    if(selectedStationId) {
        selectStation(selectedStationId);
        renderSlotControls();
    }
    
    presetButtons.forEach(btn => btn.disabled = false);
}

idealPresetBtn.addEventListener('click', () => applyPreset(slots => 
    slots.map(slot => ({ ...slot, isAvailable: true }))
));
normalPresetBtn.addEventListener('click', () => applyPreset(slots => 
    slots.map(slot => ({ ...slot, isAvailable: Math.random() > 0.5 }))
));
busyPresetBtn.addEventListener('click', () => applyPreset(slots => 
    slots.map(slot => ({ ...slot, isAvailable: false }))
));

async function initialize() { 
    await fetchStations();
}

initialize();
