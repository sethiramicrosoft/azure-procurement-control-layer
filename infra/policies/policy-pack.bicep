targetScope = 'subscription'

@description('Location for policy assignment identity and metadata resources')
param location string = 'australiaeast'

@description('Name of the policy initiative assignment')
param assignmentName string = 'apcl-baseline-assignment'

@description('Allowed Azure regions for governed deployments')
param allowedLocations array = [
  'australiaeast'
  'australiasoutheast'
]

@description('Allowed VM SKUs for governed deployments')
param allowedVmSkus array = [
  'Standard_D2s_v5'
  'Standard_D4s_v5'
]

@description('Allowed values for CostCenter tag')
param allowedCostCenters array = [
  'FIN001'
  'ENG001'
]

var requireCostCenterPolicyName = 'apcl-require-costcenter'
var requirePoPolicyName = 'apcl-require-poid'
var requireOwnerPolicyName = 'apcl-require-owner'
var requireRequestPolicyName = 'apcl-require-requestid'
var allowedLocationsPolicyName = 'apcl-allowed-locations'
var allowedVmSkuPolicyName = 'apcl-allowed-vm-skus'
var allowedCostCenterTagPolicyName = 'apcl-allowed-costcenter-tag'

resource requireCostCenter 'Microsoft.Authorization/policyDefinitions@2023-04-01' = {
  name: requireCostCenterPolicyName
  properties: {
    policyType: 'Custom'
    mode: 'Indexed'
    displayName: 'APCL - Require CostCenter tag'
    description: 'Ensures CostCenter tag exists on resources.'
    metadata: {
      category: 'APCL'
    }
    policyRule: {
      if: {
        field: 'tags[CostCenter]'
        exists: 'false'
      }
      then: {
        effect: 'deny'
      }
    }
  }
}

resource requirePoId 'Microsoft.Authorization/policyDefinitions@2023-04-01' = {
  name: requirePoPolicyName
  properties: {
    policyType: 'Custom'
    mode: 'Indexed'
    displayName: 'APCL - Require PO_ID tag'
    description: 'Ensures PO_ID tag exists on resources.'
    metadata: {
      category: 'APCL'
    }
    policyRule: {
      if: {
        field: 'tags[PO_ID]'
        exists: 'false'
      }
      then: {
        effect: 'deny'
      }
    }
  }
}

resource requireOwner 'Microsoft.Authorization/policyDefinitions@2023-04-01' = {
  name: requireOwnerPolicyName
  properties: {
    policyType: 'Custom'
    mode: 'Indexed'
    displayName: 'APCL - Require Owner tag'
    description: 'Ensures Owner tag exists on resources.'
    metadata: {
      category: 'APCL'
    }
    policyRule: {
      if: {
        field: 'tags[Owner]'
        exists: 'false'
      }
      then: {
        effect: 'deny'
      }
    }
  }
}

resource requireRequestId 'Microsoft.Authorization/policyDefinitions@2023-04-01' = {
  name: requireRequestPolicyName
  properties: {
    policyType: 'Custom'
    mode: 'Indexed'
    displayName: 'APCL - Require RequestId tag'
    description: 'Ensures RequestId tag exists on resources.'
    metadata: {
      category: 'APCL'
    }
    policyRule: {
      if: {
        field: 'tags[RequestId]'
        exists: 'false'
      }
      then: {
        effect: 'deny'
      }
    }
  }
}

resource allowedLocationsDef 'Microsoft.Authorization/policyDefinitions@2023-04-01' = {
  name: allowedLocationsPolicyName
  properties: {
    policyType: 'Custom'
    mode: 'Indexed'
    displayName: 'APCL - Allowed locations'
    description: 'Restricts deployments to approved regions.'
    metadata: {
      category: 'APCL'
    }
    policyRule: {
      if: {
        allOf: [
          {
            field: 'location'
            notIn: allowedLocations
          }
          {
            field: 'location'
            notEquals: 'global'
          }
        ]
      }
      then: {
        effect: 'deny'
      }
    }
  }
}

resource allowedVmSkuDef 'Microsoft.Authorization/policyDefinitions@2023-04-01' = {
  name: allowedVmSkuPolicyName
  properties: {
    policyType: 'Custom'
    mode: 'Indexed'
    displayName: 'APCL - Allowed VM SKUs'
    description: 'Restricts VM size choices to approved SKUs.'
    metadata: {
      category: 'APCL'
    }
    policyRule: {
      if: {
        allOf: [
          {
            field: 'type'
            equals: 'Microsoft.Compute/virtualMachines'
          }
          {
            field: 'Microsoft.Compute/virtualMachines/sku.name'
            notIn: allowedVmSkus
          }
        ]
      }
      then: {
        effect: 'deny'
      }
    }
  }
}

resource allowedCostCenterTagDef 'Microsoft.Authorization/policyDefinitions@2023-04-01' = {
  name: allowedCostCenterTagPolicyName
  properties: {
    policyType: 'Custom'
    mode: 'Indexed'
    displayName: 'APCL - Allowed CostCenter values'
    description: 'Restricts CostCenter tag to approved values.'
    metadata: {
      category: 'APCL'
    }
    policyRule: {
      if: {
        allOf: [
          {
            field: 'tags[CostCenter]'
            exists: 'true'
          }
          {
            field: 'tags[CostCenter]'
            notIn: allowedCostCenters
          }
        ]
      }
      then: {
        effect: 'deny'
      }
    }
  }
}

resource initiative 'Microsoft.Authorization/policySetDefinitions@2023-04-01' = {
  name: 'apcl-baseline-initiative'
  properties: {
    policyType: 'Custom'
    displayName: 'APCL Baseline Governance Initiative'
    description: 'Baseline procurement-aware governance controls for Azure consumption.'
    metadata: {
      category: 'APCL'
      version: '1.0.0'
    }
    policyDefinitions: [
      {
        policyDefinitionId: requireCostCenter.id
      }
      {
        policyDefinitionId: requirePoId.id
      }
      {
        policyDefinitionId: requireOwner.id
      }
      {
        policyDefinitionId: requireRequestId.id
      }
      {
        policyDefinitionId: allowedLocationsDef.id
      }
      {
        policyDefinitionId: allowedVmSkuDef.id
      }
      {
        policyDefinitionId: allowedCostCenterTagDef.id
      }
    ]
  }
}

resource initiativeAssignment 'Microsoft.Authorization/policyAssignments@2024-04-01' = {
  name: assignmentName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    displayName: 'APCL Baseline Assignment'
    policyDefinitionId: initiative.id
    enforcementMode: 'Default'
  }
}
