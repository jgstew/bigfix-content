// Replaces src/App.js in the WebUI SDK app template.
import React from 'react'

import { BfApp } from 'bfcore-react'
import SessionRelevanceQuery from 'SessionRelevanceQuery/SessionRelevanceQuery'
import packageJson from '../package.json'
const App = () => {
  const extensionDisplayName = packageJson && packageJson?.displayName
  return (
    <BfApp title={extensionDisplayName} appTitle={extensionDisplayName}>
      <SessionRelevanceQuery />
    </BfApp>
  )
}

export default App
