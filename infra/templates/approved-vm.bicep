@description('Azure region for VM deployment')
param location string

@description('VM name')
param vmName string

@description('Administrator username')
param adminUsername string

@secure()
@description('Administrator password')
param adminPassword string

@description('Cost center tag value')
param costCenter string

@description('PO identifier tag value')
param poId string

@description('Owner tag value (email or alias)')
param owner string

@description('Approved request identifier')
param requestId string

@description('VM size (must be policy-compliant)')
param vmSku string = 'Standard_D2s_v5'

resource vnet 'Microsoft.Network/virtualNetworks@2023-09-01' = {
  name: '${vmName}-vnet'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.10.0.0/16'
      ]
    }
    subnets: [
      {
        name: 'default'
        properties: {
          addressPrefix: '10.10.1.0/24'
        }
      }
    ]
  }
  tags: {
    CostCenter: costCenter
    PO_ID: poId
    Owner: owner
    RequestId: requestId
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2023-09-01' = {
  name: '${vmName}-nic'
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: '${vnet.id}/subnets/default'
          }
        }
      }
    ]
  }
  tags: {
    CostCenter: costCenter
    PO_ID: poId
    Owner: owner
    RequestId: requestId
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2023-09-01' = {
  name: vmName
  location: location
  properties: {
    hardwareProfile: {
      vmSize: vmSku
    }
    osProfile: {
      computerName: vmName
      adminUsername: adminUsername
      adminPassword: adminPassword
      linuxConfiguration: {
        disablePasswordAuthentication: false
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: '0001-com-ubuntu-server-jammy'
        sku: '22_04-lts-gen2'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        managedDisk: {
          storageAccountType: 'Standard_LRS'
        }
      }
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
        }
      ]
    }
  }
  tags: {
    CostCenter: costCenter
    PO_ID: poId
    Owner: owner
    RequestId: requestId
  }
  dependsOn: [
    nic
  ]
}
