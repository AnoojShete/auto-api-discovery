const express = require('express');

const app = express();
app.use(express.json());

app.post('/graphql', (req, res) => {
  const query = req.body?.query || '';
  const variables = req.body?.variables || {};

  if (query.includes('mutation')) {
    return res.json({
      data: {
        updateUser: {
          id: variables.id || '1',
          name: variables.name || 'Updated',
        },
      },
    });
  }

  return res.json({
    data: {
      user: {
        id: variables.id || '1',
        name: 'Graph User',
      },
      users: [
        { id: '1', name: 'Graph User' },
        { id: '2', name: 'Another User' },
      ],
    },
  });
});

const port = Number(process.env.PORT || 4001);
app.listen(port, () => {
  console.log(`[graphql] listening on http://localhost:${port}/graphql`);
});
