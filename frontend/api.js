// Talks to the backend. One function per endpoint; each returns the parsed
// JSON or throws an Error whose message is safe to show to the user.
const api = (() => {
  async function request(method, path, body) {
    let res;
    try {
      res = await fetch(API_URL + '/api' + path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new Error("Can't reach the server. Is the backend running?");
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const enc = encodeURIComponent;

  return {
    health: () => request('GET', '/health'),

    // Tournaments
    createTournament: data => request('POST', '/tournaments', data),
    listTournaments: ids => request('GET', '/tournaments?ids=' + ids.map(enc).join(',')),
    getTournament: id => request('GET', `/tournaments/${enc(id)}`),
    updateTournament: (id, data) => request('PATCH', `/tournaments/${enc(id)}`, data),
    deleteTournament: id => request('DELETE', `/tournaments/${enc(id)}`),

    // Participants
    createParticipant: data => request('POST', '/participants', data),
    listParticipants: tournamentId => request('GET', '/participants?tournament_id=' + enc(tournamentId)),
    getParticipant: id => request('GET', `/participants/${enc(id)}`),
    updateParticipant: (id, data) => request('PATCH', `/participants/${enc(id)}`, data),
    deleteParticipant: id => request('DELETE', `/participants/${enc(id)}`),
  };
})();
